/**
 * Decides what `bun run setup` would write, before anything is written.
 *
 * Two rules shape everything here:
 *
 *   - the Mac and the device must end up holding the same secret, so when one
 *     side is already configured the other is built from that secret; and
 *   - a file that already exists is never replaced, so a partly-configured or
 *     conflicting install is reported as a problem instead of being guessed at.
 *
 * A third rule keeps setup from silently picking the wrong firmware for the
 * two supported watches: the default device id follows the board the
 * firmware folder was built for, and the user can pin the board explicitly
 * with `--board`. When the firmware folder's signal is ambiguous (both
 * supported boards present, no trustworthy sdkconfig), the plan refuses to
 * guess and asks for `--board` instead - the firmware's Kconfig default is
 * the old LCD, so a silent fallback to it would mis-detect AMOLED users.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_LISTENER_PORT,
  buildFirmwareFileContent,
  buildMacEnvFileContent,
  createSharedSecret,
  firmwareConfigPath,
  isDirectory,
  macEnvFilePathFromEnvironment,
  parseFirmwareSettings,
  readEffectiveDeviceId,
  readMacSecret,
  readTextFile,
  removeFileQuietly,
  writePrivateFileExclusive,
  type SecretSource,
} from './files';
import {
  BOARDS_DIR_RELATIVE,
  buildCommandForBoard,
  detectBoard,
  defaultDeviceIdForBoard,
  isSupportedBoard,
  validateBoardId,
  FALLBACK_DEFAULT_DEVICE_ID,
  type BoardDetection,
} from './boards';
import { validateDeviceHost, validateDeviceId, validateSecretValue } from './validation';

export type PlannedFileAction = 'create' | 'keep';

export type PlannedFile = {
  readonly kind: 'mac' | 'firmware';
  readonly path: string;
  readonly action: PlannedFileAction;
  /** Present only when something will actually be written. */
  readonly content: string | null;
};

export type SetupOptions = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly macEnvFilePath?: string;
  readonly firmwareDir?: string | null;
  readonly host?: string | null;
  readonly port?: number;
  readonly deviceId?: string;
  /**
   * The watch the user is wiring the Mac for, from `--board`. When this is
   * set, it overrides whatever the firmware folder's sdkconfig or layout
   * would otherwise pick, so a stale `sdkconfig` cannot silently pick the
   * wrong default device id.
   */
  readonly board?: string | null;
  /**
   * Injectable so a unit test can pin the board detector to a known fixture
   * without writing a fake firmware folder to disk. When this is omitted, the
   * plan reads the firmware's own boards directory. The second argument is
   * the validated `--board` value, mirroring `detectBoard`.
   */
  readonly detectBoard?: (firmwareDir: string | null, requestedBoard: string | null) => BoardDetection;
  /** Injectable so tests never depend on real randomness. */
  readonly randomSecret?: () => string;
};

export type SetupPlan = {
  readonly host: string | null;
  readonly requestedUrl: string | null;
  readonly port: number;
  readonly deviceId: string;
  readonly board: string | null;
  /**
   * The exact `scripts/build.py` invocation the user should run on the
   * firmware side to build the watch that matches this plan. Null when no
   * board is known (no firmware folder and no `--board`).
   */
  readonly buildCommand: string | null;
  readonly macEnvFilePath: string;
  readonly firmwareDir: string | null;
  readonly secret: string;
  readonly secretSource: SecretSource;
  readonly files: readonly PlannedFile[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
};

export function buildSetupPlan(options: SetupOptions = {}): SetupPlan {
  const environment = options.environment ?? process.env;
  const macEnvFilePath = options.macEnvFilePath !== undefined
    ? resolve(options.macEnvFilePath)
    : macEnvFilePathFromEnvironment(environment);
  const port = options.port ?? DEFAULT_LISTENER_PORT;
  const deviceIdFromUser = options.deviceId?.trim();
  const warnings: string[] = [];
  const errors: string[] = [];

  // The address the device will dial. It goes straight into a URL, so it must
  // be only a host name or IP address.
  let host: string | null = null;
  const hostValidation = validateDeviceHost(options.host ?? '');
  if (hostValidation.ok) {
    host = hostValidation.host;
  } else {
    errors.push(hostValidation.reason);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    errors.push('Not a usable port. Pass --port with a number from 1 to 65535.');
  }
  const requestedUrl = host === null ? null : `ws://${host}:${port}`;

  let firmwareDir: string | null = null;
  if (options.firmwareDir !== undefined && options.firmwareDir !== null) {
    const wanted = resolve(options.firmwareDir);
    if (!existsSync(wanted) || !isDirectory(wanted)) {
      errors.push('Firmware folder not found. Nothing will be written for the device.');
    } else {
      firmwareDir = wanted;
    }
  } else {
    warnings.push(
      'No firmware folder given, so the device config was not written. Re-run with --firmware-dir <path>.',
    );
  }

  // Validate `--board` first: the value either names a supported watch, or
  // the user has to fix the command. Doing this before detection also lets
  // `--board` override the firmware folder's own state below.
  const boardFromCli = options.board ?? null;
  const boardValidation = validateBoardId(boardFromCli);
  if (boardValidation !== null) {
    errors.push(boardValidation);
  }
  const validatedBoard = boardValidation === null && boardFromCli !== null && boardFromCli.length > 0
    ? boardFromCli
    : null;

  // Read the firmware's own boards directory to decide which watch is being
  // built. Detection is read-only and uses the same file the firmware's
  // build script reads, so the two cannot disagree about what is on disk.
  const boardDetector = options.detectBoard ?? detectBoard;
  const boardDetection = boardDetector(firmwareDir, validatedBoard);
  let detectedBoard: string | null = null;
  switch (boardDetection.state) {
    case 'one':
      detectedBoard = boardDetection.board;
      break;
    case 'none':
      // No firmware folder, or one with no boards directory. The plan keeps
      // moving with the historic fallback; setup has nothing to mis-detect.
      break;
    case 'ambiguous': {
      // Both supported boards are present and the firmware's own signal is
      // not trustworthy (no sdkconfig, or one that names a board not in this
      // checkout). The Kconfig default is the old LCD, so a silent fallback
      // would mis-detect AMOLED users. Ask for `--board` instead.
      const listed = boardDetection.found.join(', ');
      const sdkconfigNote = boardDetection.sdkconfigTrusted
        ? ''
        : ' No trustworthy sdkconfig was found in the firmware folder.';
      errors.push(
        `Firmware folder holds more than one supported watch (${listed}).${sdkconfigNote} Re-run with --board <${boardDetection.found.join('|')}> so setup picks the right default device id.`,
      );
      break;
    }
    case 'unsupported': {
      const listed = boardDetection.found.join(', ');
      if (listed.length > 0) {
        errors.push(
          `Firmware folder holds no supported board (found: ${listed}). Re-run with --board <1.85C|2.06> after building for a supported watch, or build the firmware for one of: 1.85C, AMOLED 2.06.`,
        );
      } else {
        errors.push(
          'Firmware folder holds no supported board. Re-run with --board <1.85C|2.06> after building for a supported watch.',
        );
      }
      break;
    }
    case 'unreadable':
      errors.push(
        `Firmware boards directory could not be read: ${boardDetection.reason}. Fix the permissions, or pass --board.`,
      );
      break;
  }

  // If the user named a board with --board, but the firmware folder does
  // not carry that board's source, the build they run on the firmware side
  // will fail. Surface that now so the wrong firmware does not get flashed
  // a few minutes later when nothing matches.
  if (
    validatedBoard !== null &&
    firmwareDir !== null &&
    boardDetection.state === 'one' &&
    boardDetection.source === 'requested' &&
    !hasBoardSourceInFirmwareDir(firmwareDir, validatedBoard)
  ) {
    warnings.push(
      `--board ${validatedBoard} was applied, but the firmware folder does not contain a ${validatedBoard} source. Build it with: ${buildCommandForBoard(validatedBoard)}.`,
    );
  }

  // Pick the device id. The order matters and is fixed:
  //   1. The user passed --device-id; that wins outright, even on a board
  //      that would have wanted a different default, because the user is the
  //      one holding the device.
  //   2. A board is known (because the user passed --board, or detection
  //      found exactly one), so the catalog default for that board is used.
  //      This is how a fresh 1.85C clone becomes "desk" and a fresh
  //      AMOLED 2.06 clone becomes "watch" without the user typing anything.
  //   3. Otherwise (no firmware folder, or no board could be read), fall
  //      back to the historic default so the prompt still has something to
  //      print.
  let deviceId: string;
  if (deviceIdFromUser !== undefined && deviceIdFromUser.length > 0) {
    deviceId = deviceIdFromUser;
  } else if (detectedBoard !== null) {
    deviceId = defaultDeviceIdForBoard(detectedBoard);
  } else {
    deviceId = FALLBACK_DEFAULT_DEVICE_ID;
  }
  const deviceIdError = validateDeviceId(deviceId);
  if (deviceIdError !== null) {
    errors.push(deviceIdError);
  }

  const macContent = readTextFile(macEnvFilePath);
  const macExists = macContent !== null;

  const firmwareFilePath = firmwareDir === null ? null : firmwareConfigPath(firmwareDir);
  const firmwareContent = firmwareFilePath === null ? null : readTextFile(firmwareFilePath);
  const firmwareExists = firmwareContent !== null;
  const firmwareSettings = firmwareContent === null ? null : parseFirmwareSettings(firmwareContent);
  const firmwareToken = firmwareSettings?.token ?? null;

  // Warn when the firmware folder says one board and the user asked setup to
  // name the device something the catalog does not expect for that board.
  // This is the most common way the wrong firmware would otherwise be
  // flashed: the user is wiring the Mac for a 1.85C but the watch on the
  // bench is actually a 2.06, or vice versa.
  if (
    detectedBoard !== null &&
    deviceIdFromUser !== undefined &&
    deviceIdFromUser.length > 0 &&
    deviceIdFromUser !== defaultDeviceIdForBoard(detectedBoard)
  ) {
    // The firmware folder says one watch; the user asked for the other watch's
    // name. Honour the user but spell out the mismatch so the wrong firmware
    // does not get flashed unnoticed.
    warnings.push(
      `The firmware folder is for the ${detectedBoard}, whose default device id is "${defaultDeviceIdForBoard(detectedBoard)}". --device-id ${deviceIdFromUser} was applied; flash the matching firmware or restore the default.`,
    );
  }

  const macSecret = readMacSecret(environment, macContent);
  let secret: string;
  let secretSource: SecretSource;
  if (macSecret.state === 'present') {
    secret = macSecret.secret;
    secretSource = macSecret.source;
  } else if (macSecret.state === 'empty-override') {
    secret = (options.randomSecret ?? createSharedSecret)();
    secretSource = 'generated';
    errors.push(
      'VOICEMODE_DEVICE_SECRET is set to an empty value, so the listener would refuse to start. Unset it, or give it a value.',
    );
  } else if (firmwareToken !== null) {
    secret = firmwareToken;
    secretSource = 'firmware';
  } else {
    secret = (options.randomSecret ?? createSharedSecret)();
    secretSource = 'generated';
  }

  // A file that exists but carries no secret is not something setup can fix
  // without replacing it, which it will not do.
  if (macExists && macSecret.state === 'missing') {
    errors.push(
      'The Mac config file exists but has no DEVICE_SHARED_SECRET. Setup will not overwrite it; add the secret by hand, or delete the file and run setup again.',
    );
  }
  if (firmwareExists && firmwareToken === null) {
    errors.push(
      'The device config exists but has no CONFIG_VOICEMODE_TOKEN. Setup will not overwrite it; add the secret by hand, or delete the file and run setup again.',
    );
  }
  if (
    macExists &&
    firmwareExists &&
    macSecret.state === 'present' &&
    firmwareToken !== null &&
    macSecret.secret !== firmwareToken
  ) {
    errors.push(
      'The Mac config and the device config hold different secrets. Setup will not overwrite either; fix one by hand, or delete it and run setup again.',
    );
  }
  if (
    macSecret.state === 'present' &&
    macSecret.source === 'environment' &&
    firmwareToken !== null &&
    macSecret.secret !== firmwareToken
  ) {
    errors.push(
      'VOICEMODE_DEVICE_SECRET does not match the device config, and setup will not overwrite the device config. Unset it, or change the device config by hand.',
    );
  }

  const secretError = validateSecretValue(secret);
  if (secretError !== null) {
    errors.push(secretError);
  }

  // The device id the firmware will actually report is the one in the
  // generated `sdkconfig` when a build has been run, falling back to the
  // local override file. The local file can deliberately retain an old
  // value for a board whose build fragment overrides it, so comparing
  // against the local file alone produces a false mismatch.
  const effectiveDeviceId = firmwareDir === null
    ? null
    : readEffectiveDeviceId(firmwareDir);

  // If the device config stays as it is, say plainly which requested settings
  // did not take effect, so nothing reads as "all in place" when it is not.
  if (firmwareExists && firmwareSettings !== null) {
    if (firmwareSettings.url === null) {
      warnings.push('The device config has no CONFIG_VOICEMODE_URL; setup left it as it is.');
    } else if (requestedUrl !== null && firmwareSettings.url !== requestedUrl) {
      warnings.push('The device config already points somewhere else, so --host/--port were not applied; setup left it as it is.');
    }
    const effectiveId = effectiveDeviceId?.deviceId ?? null;
    if (effectiveId === null) {
      warnings.push('The device config has no CONFIG_VOICEMODE_DEVICE_ID; setup left it as it is.');
    } else if (effectiveId !== deviceId) {
      // The effective id (from the generated sdkconfig or the local file)
      // disagrees with what this plan would write. The file is left alone,
      // and the user is told which source the device is actually using.
      const sourceLabel = effectiveDeviceId?.source === 'generated'
        ? 'generated sdkconfig'
        : 'sdkconfig.defaults.local';
      if (deviceIdFromUser !== undefined && deviceIdFromUser.length > 0) {
        warnings.push(
          `The ${sourceLabel} already names "${effectiveId}", which differs from --device-id ${deviceId}. Setup left it as it is.`,
        );
      } else {
        warnings.push(
          `The ${sourceLabel} already names "${effectiveId}", so the ${detectedBoard ?? 'firmware folder'} default ("${deviceId}") was not applied; setup left it as it is.`,
        );
      }
    } else if (firmwareSettings.deviceId !== null && firmwareSettings.deviceId !== deviceId) {
      // The effective id (from the generated sdkconfig) matches what setup
      // would write, but the local override file still carries a different
      // value. That value is harmless when a build fragment overrides it,
      // but it is worth telling the user it is out of sync with the local
      // file so they can clean it up if they want.
      warnings.push(
        `sdkconfig.defaults.local still names "${firmwareSettings.deviceId}", but the generated sdkconfig already reports "${effectiveId}". The build is what the device will use; update the local file by hand if you want them to match.`,
      );
    }
  }

  const files: PlannedFile[] = [];
  files.push({
    kind: 'mac',
    path: macEnvFilePath,
    action: macExists ? 'keep' : 'create',
    content: macExists ? null : buildMacEnvFileContent(secret),
  });
  if (firmwareFilePath !== null) {
    const contentHost = host;
    files.push({
      kind: 'firmware',
      path: firmwareFilePath,
      action: firmwareExists ? 'keep' : 'create',
      content: firmwareExists || contentHost === null
        ? null
        : buildFirmwareFileContent({ secret, host: contentHost, port, deviceId }),
    });
  }

  return {
    host,
    requestedUrl,
    port,
    deviceId,
    board: detectedBoard,
    buildCommand: detectedBoard === null ? null : buildCommandForBoard(detectedBoard),
    macEnvFilePath,
    firmwareDir,
    secret,
    secretSource,
    files,
    warnings,
    errors,
  };
}

/**
 * Whether the firmware's `main/boards/waveshare/<board>` directory exists.
 * Used to spot a `--board` value that the user wants but the checkout does
 * not have, so the warning can name the build command they need to run.
 */
function hasBoardSourceInFirmwareDir(firmwareDir: string, board: string): boolean {
  return isDirectory(join(firmwareDir, BOARDS_DIR_RELATIVE, board));
}

/** A plan with the secret stripped out, safe to print. */
export type SetupPreview = {
  readonly host: string | null;
  readonly port: number;
  readonly deviceId: string;
  readonly board: string | null;
  readonly buildCommand: string | null;
  readonly secretSource: SecretSource;
  readonly mac: { readonly path: string; readonly action: PlannedFileAction };
  readonly firmware: { readonly path: string; readonly action: PlannedFileAction } | null;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
};

export function buildSetupPreview(plan: SetupPlan): SetupPreview {
  const mac = plan.files.find((file) => file.kind === 'mac');
  const firmware = plan.files.find((file) => file.kind === 'firmware');
  return {
    host: plan.host,
    port: plan.port,
    deviceId: plan.deviceId,
    board: plan.board,
    buildCommand: plan.buildCommand,
    secretSource: plan.secretSource,
    mac: { path: mac?.path ?? plan.macEnvFilePath, action: mac?.action ?? 'keep' },
    firmware: firmware === undefined ? null : { path: firmware.path, action: firmware.action },
    warnings: plan.warnings,
    errors: plan.errors,
  };
}

/**
 * Write the plan's new files. It refuses a plan that already found a problem,
 * a second time, so nothing can be written even if a caller forgets to check.
 * If a later write fails, only files this call created are removed - a file
 * that was already there is never touched.
 */
export function applySetupPlan(plan: SetupPlan): { readonly created: readonly string[] } {
  if (plan.errors.length > 0) {
    throw new Error(`Refusing to write while the plan has problems: ${plan.errors[0]}`);
  }
  const created: string[] = [];
  try {
    for (const file of plan.files) {
      if (file.action !== 'create' || file.content === null) {
        continue;
      }
      writePrivateFileExclusive(file.path, file.content);
      created.push(file.path);
    }
  } catch (error) {
    for (const filePath of created) {
      removeFileQuietly(filePath);
    }
    throw error;
  }
  return { created };
}

// Re-export so a caller that only imports the plan can see which board ids
// the plan understands, without reaching into the boards module directly.
export { isSupportedBoard };
