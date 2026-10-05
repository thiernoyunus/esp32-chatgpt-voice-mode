/**
 * `bun run doctor`: a read-only check of one Mac's voice-mode setup.
 *
 * It answers four questions without changing anything: is there a shared
 * secret, does the device config carry the same one, is Codex where the
 * listener expects it, and is a listener answering locally?
 *
 * The report is a fixed list of facts. It never contains the secret, the
 * contents of the environment, a file path, log text, or anything spoken, and
 * any text taken from the listener is rebuilt rather than copied.
 */
import {
  DEFAULT_LISTENER_PORT,
  detectFirmwareDir,
  firmwareConfigPath,
  macEnvFilePathFromEnvironment,
  privateFileModeLabel,
  readFirmwareSettings,
  readMacSecret,
  readTextFile,
  type EffectiveDeviceId,
  type FirmwareSettings,
} from './files';
import { join } from 'node:path';
import { buildCommandForBoard, detectBoard, defaultDeviceIdForBoard, type BoardDetection } from './boards';
import { probeCodexVersion, type CodexVersionProbe } from './codex-path';
import {
  PATH_CODEX_EXECUTABLE,
  isEmptyOverride,
  resolveCodexExecutable,
  type CodexExecutableSource,
} from '../codex-executable';
import { probeListener, type CompanionStatus, type ListenerProbe } from './health-probe';

export type DoctorOptions = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory?: string;
  readonly macEnvFilePath?: string;
  readonly firmwareDir?: string | null;
  readonly codexBinOverride?: string | null;
  readonly host?: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injectable so a timeout test does not have to wait seconds. */
  readonly listenerTimeoutMilliseconds?: number;
  /** Injectable so tests never launch a real program. */
  readonly probeVersion?: (executablePath: string) => Promise<CodexVersionProbe>;
  readonly codexFileExists?: (path: string) => boolean;
  readonly bundledCodexPath?: string;
  /** Injectable PATH lookup for the bare `codex` name. */
  readonly whichCodex?: () => string | null;
  readonly now?: () => Date;
  /**
   * Injectable so a unit test can pin the board detector to a known fixture
   * without writing a fake firmware folder to disk. When this is omitted, the
   * doctor reads the firmware's own boards directory.
   */
  readonly detectBoard?: (firmwareDir: string | null) => BoardDetection;
};

export type DoctorReport = {
  readonly service: 'esp32-voice-mode';
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly ok: boolean;
  readonly config: {
    readonly envFilePresent: boolean;
    readonly secretPresent: boolean;
    readonly secretSource: 'environment' | 'env-file' | 'none';
    readonly secretFileMode: '0600' | 'other' | 'absent';
  };
  readonly firmware: {
    readonly checked: boolean;
    readonly filePresent: boolean;
    readonly secretPresent: boolean;
    readonly secretMatches: boolean | null;
    readonly detectedBoard: string | null;
    /**
     * The device id the firmware will actually report after a build, taken
     * from the generated `sdkconfig` when present and from the local
     * override file otherwise. Null when neither file has the value.
     */
    readonly effectiveDeviceId: string | null;
    /**
     * Where `effectiveDeviceId` came from. `'generated'` is the resolved
     * build output, which is authoritative; `'local'` means no build has
     * produced a value yet, so the local override file is what counts.
     */
    readonly effectiveDeviceIdSource: 'generated' | 'local' | 'none';
    readonly deviceIdMatchesBoard: boolean | null;
  };
  readonly codex: {
    readonly executablePresent: boolean;
    readonly executableSource: CodexExecutableSource;
    readonly version: string | null;
    readonly versionTimedOut: boolean;
  };
  readonly listener: {
    readonly checked: boolean;
    readonly reachable: boolean;
    readonly status: number | null;
    readonly companionStatus: CompanionStatus | null;
    readonly deviceConnected: boolean | null;
    readonly activeCalls: number | null;
    readonly lastError: { readonly code: string; readonly message: string } | null;
    readonly oldListener: boolean;
    readonly processPresent: boolean;
    readonly timedOut: boolean;
  };
  readonly warnings: readonly string[];
};

export const DEFAULT_LISTENER_HOST = '127.0.0.1';

function readEnvFileSafely(filePath: string): { content: string | null; failed: boolean } {
  try {
    return { content: readTextFile(filePath), failed: false };
  } catch {
    return { content: null, failed: true };
  }
}

function readFirmwareSafely(filePath: string): { settings: FirmwareSettings | null; failed: boolean } {
  try {
    return { settings: readFirmwareSettings(filePath), failed: false };
  } catch {
    return { settings: null, failed: true };
  }
}

/**
 * Read the device id the firmware will actually use, tolerating a local
 * file the user cannot read (e.g. permissions set to 0o000 by a test). The
 * generated file is preferred; the local file is only consulted when the
 * generated file is missing or has no value. A read failure on either
 * file is treated as "no value from that source" so the doctor can still
 * report something useful.
 */
function readEffectiveDeviceIdSafely(firmwareDir: string): EffectiveDeviceId & { readonly failed: boolean } {
  const generatedPath = join(firmwareDir, 'sdkconfig');
  const localPath = firmwareConfigPath(firmwareDir);
  let generated: { settings: FirmwareSettings | null; failed: boolean };
  try {
    generated = readFirmwareSafely(generatedPath);
  } catch {
    generated = { settings: null, failed: true };
  }
  if (generated.failed) {
    // A generated file that exists but cannot be read is unusual; the
    // local file is still worth a try, and the caller will see `failed`.
    // Fall through to the local fallback.
  } else if (generated.settings !== null && generated.settings.deviceId !== null) {
    return { source: 'generated', deviceId: generated.settings.deviceId, failed: false };
  }
  const local = readFirmwareSafely(localPath);
  if (local.settings !== null && local.settings.deviceId !== null) {
    return { source: 'local', deviceId: local.settings.deviceId, failed: local.failed };
  }
  return { source: 'none', deviceId: null, failed: generated.failed || local.failed };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const macEnvFilePath = options.macEnvFilePath !== undefined
    ? options.macEnvFilePath
    : macEnvFilePathFromEnvironment(environment);
  const warnings: string[] = [];

  // 1. The Mac's shared secret.
  const envFile = readEnvFileSafely(macEnvFilePath);
  const macSecret = readMacSecret(environment, envFile.content);
  const secretPresent = macSecret.state === 'present';
  const secretSource = macSecret.state === 'present' ? macSecret.source : 'none';
  const secretFileMode = envFile.content === null ? 'absent' : privateFileModeLabel(macEnvFilePath);

  if (envFile.failed) {
    warnings.push('The Mac config file could not be read. Check its permissions.');
  }
  if (macSecret.state === 'empty-override') {
    warnings.push('VOICEMODE_DEVICE_SECRET is empty, so the listener would refuse to start.');
  } else if (macSecret.state === 'missing') {
    if (envFile.content !== null) {
      warnings.push('The Mac config file has no DEVICE_SHARED_SECRET. Add one by hand, or delete the file and run bun run setup.');
    } else if (!envFile.failed) {
      warnings.push('No Mac config file yet. Run bun run setup.');
    }
  }
  if (envFile.content !== null && secretFileMode === 'other') {
    warnings.push('The Mac config file is readable by other users; it should be 0600.');
  }

  // 2. Whether the device config carries the same secret (only if we can find it).
  const firmwareDir = options.firmwareDir !== undefined
    ? options.firmwareDir
    : detectFirmwareDir(options.workingDirectory ?? process.cwd(), environment);
  let firmwareFilePresent = false;
  let firmwareSecretPresent = false;
  let firmwareSecretMatches: boolean | null = null;
  let firmwareChecked = false;
  if (firmwareDir === null) {
    warnings.push('No firmware folder found, so the device config was not compared. Pass --firmware-dir.');
  } else {
    firmwareChecked = true;
    const firmwareFile = readFirmwareSafely(firmwareConfigPath(firmwareDir));
    if (firmwareFile.failed) {
      warnings.push('The device config could not be read. Check its permissions.');
    } else {
      const settings = firmwareFile.settings;
      firmwareFilePresent = settings !== null;
      firmwareSecretPresent = settings?.token !== null && settings?.token !== undefined;
      if (settings === null) {
        warnings.push('The device config is not there yet. Run bun run setup with --firmware-dir.');
      } else if (!firmwareSecretPresent) {
        warnings.push('The device config has no CONFIG_VOICEMODE_TOKEN, so the device would be refused. Fix it by hand, or delete it and run setup again.');
      } else if (settings.url === null) {
        warnings.push('The device config has no CONFIG_VOICEMODE_URL, so the device would not know where to dial.');
      }
      if (settings !== null && firmwareSecretPresent && macSecret.state === 'present') {
        firmwareSecretMatches = settings.token === macSecret.secret;
        if (firmwareSecretMatches === false) {
          warnings.push('The Mac and the device hold different secrets, so the device will be refused. Setup will not overwrite them; fix one by hand.');
        }
      }
    }
  }
  // 2b. What the firmware folder says the watch is, and whether the device
  // id the firmware will actually report matches the one that board would
  // have picked. A mismatch here is the usual way the wrong firmware ends
  // up on the wrong watch, so the doctor calls it out without going so far
  // as to fail. The id comes from the generated `sdkconfig` when a build
  // has been run, falling back to the local override file: the local file
  // can deliberately retain an old value for a board whose build fragment
  // overrides it, and the generated file is what the device will see.
  const boardDetector = options.detectBoard ?? detectBoard;
  const boardDetection = boardDetector(firmwareDir);
  let detectedBoard: string | null = null;
  let deviceIdMatchesBoard: boolean | null = null;
  const effectiveDeviceId = firmwareDir === null
    ? { source: 'none' as const, deviceId: null, failed: false }
    : readEffectiveDeviceIdSafely(firmwareDir);
  if (boardDetection.state === 'one') {
    detectedBoard = boardDetection.board;
    const storedDeviceId = effectiveDeviceId.deviceId;
    if (storedDeviceId !== null) {
      deviceIdMatchesBoard = storedDeviceId === defaultDeviceIdForBoard(detectedBoard);
      if (deviceIdMatchesBoard === false) {
        const sourceNote = effectiveDeviceId.source === 'generated'
          ? 'the generated sdkconfig'
          : 'sdkconfig.defaults.local';
        warnings.push(
          `The firmware folder is for the ${detectedBoard}, whose default device id is "${defaultDeviceIdForBoard(detectedBoard)}". ${sourceNote} names "${storedDeviceId}", which would match a different watch; check that the right firmware is on the device.`,
        );
      }
    }
  } else if (boardDetection.state === 'unsupported') {
    const listed = boardDetection.found.join(', ');
    if (listed.length > 0) {
      warnings.push(
        `Firmware folder holds no supported watch (found: ${listed}). Re-run with --firmware-dir, or pass a path to a 1.85C or AMOLED 2.06 build.`,
      );
    } else {
      warnings.push(
        'Firmware folder holds no supported watch. Re-run with --firmware-dir, or pass a path to a 1.85C or AMOLED 2.06 build.',
      );
    }
  } else if (boardDetection.state === 'unreadable') {
    warnings.push(`Firmware boards directory could not be read: ${boardDetection.reason}.`);
  }

  const firmware = {
    checked: firmwareChecked,
    filePresent: firmwareFilePresent,
    secretPresent: firmwareSecretPresent,
    secretMatches: firmwareSecretMatches,
    detectedBoard,
    effectiveDeviceId: effectiveDeviceId.deviceId,
    effectiveDeviceIdSource: effectiveDeviceId.source,
    deviceIdMatchesBoard,
  };

  // 3. Codex, found the way the listener finds it.
  const resolution = resolveCodexExecutable({
    environment: options.codexBinOverride !== undefined && options.codexBinOverride !== null
      ? { ...environment, VOICEMODE_CODEX_BIN: options.codexBinOverride }
      : environment,
    fileExists: options.codexFileExists,
    bundledPath: options.bundledCodexPath,
  });
  let executablePath = resolution.path;
  if (resolution.source === 'path') {
    const onPath = (options.whichCodex ?? (() => Bun.which(PATH_CODEX_EXECUTABLE)))();
    if (onPath !== null) {
      executablePath = onPath;
    }
  }
  const versionProbe = options.probeVersion !== undefined
    ? await options.probeVersion(executablePath)
    : await probeCodexVersion(executablePath);
  if (isEmptyOverride(resolution)) {
    warnings.push('VOICEMODE_CODEX_BIN is set to an empty value, so the listener would not find Codex.');
  } else if (!versionProbe.present) {
    warnings.push(
      resolution.source === 'path'
        ? 'Codex was not found in the ChatGPT app or on PATH. Install or update the ChatGPT app, or set VOICEMODE_CODEX_BIN.'
        : 'Codex was not found where it is expected. Install or update the ChatGPT app, or set VOICEMODE_CODEX_BIN.',
    );
  } else if (versionProbe.timedOut) {
    warnings.push('Codex did not answer --version in time.');
  } else if (versionProbe.failed) {
    warnings.push('Codex answered --version with an error.');
  } else if (versionProbe.version === null) {
    warnings.push('Codex answered --version in a form this check did not recognise.');
  }

  // 4. A listener running on this Mac.
  const probe: ListenerProbe = await probeListener({
    host: options.host ?? DEFAULT_LISTENER_HOST,
    port: options.port ?? DEFAULT_LISTENER_PORT,
    fetchImpl: options.fetchImpl,
    timeoutMilliseconds: options.listenerTimeoutMilliseconds,
  });
  if (probe.skipped) {
    warnings.push('The readiness report is local-only, and that address is not this Mac, so no check was sent.');
  } else if (!probe.reachable) {
    warnings.push(
      probe.timedOut
        ? 'The listener did not answer in time. Is it running on this port?'
        : 'No listener answered on this port. Start it, or reinstall the background service.',
    );
  } else if (probe.oldListener) {
    warnings.push('An older listener is running: it has no /health report. Reinstall the background service to get readiness checks.');
  } else if (probe.facts === null) {
    warnings.push('Something answered on this port but its report was not a usable esp32-voice-mode schema 1 report.');
  } else if (probe.facts.companionStatus === 'starting') {
    warnings.push('The listener is up; Codex has not finished starting yet.');
  } else if (probe.facts.companionStatus === 'failed') {
    warnings.push('The listener reported that its Codex process failed.');
  } else if (probe.status !== 200) {
    warnings.push(`The listener is answering with status ${probe.status ?? 'nothing'} rather than a ready report.`);
  }

  const companionStatus = probe.facts?.companionStatus ?? null;
  const firmwareOk = !firmware.checked || (firmware.filePresent && firmware.secretPresent && firmware.secretMatches === true);
  const versionOk = versionProbe.present && !versionProbe.timedOut && !versionProbe.failed;
  const ok =
    secretPresent &&
    firmwareOk &&
    versionOk &&
    probe.reachable &&
    !probe.oldListener &&
    !probe.timedOut &&
    probe.status === 200 &&
    companionStatus === 'ready';

  const now = options.now ?? (() => new Date());
  return {
    service: 'esp32-voice-mode',
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    ok,
    config: { envFilePresent: envFile.content !== null, secretPresent, secretSource, secretFileMode },
    firmware,
    codex: {
      executablePresent: versionProbe.present,
      executableSource: resolution.source,
      version: versionProbe.version,
      versionTimedOut: versionProbe.timedOut,
    },
    listener: {
      checked: !probe.skipped,
      reachable: probe.reachable,
      status: probe.status,
      companionStatus,
      deviceConnected: probe.facts?.deviceConnected ?? null,
      activeCalls: probe.facts?.activeCalls ?? null,
      lastError: probe.facts?.lastError ?? null,
      oldListener: probe.oldListener,
      processPresent: probe.processPresent,
      timedOut: probe.timedOut,
    },
    warnings,
  };
}

export function renderDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function describeSecret(report: DoctorReport): string {
  if (!report.config.secretPresent) {
    return 'missing';
  }
  const where = report.config.secretSource === 'environment' ? 'from the environment' : 'from the config file';
  return `present (${where}), file permissions ${report.config.secretFileMode}`;
}

function describeFirmware(report: DoctorReport): string {
  if (!report.firmware.checked) {
    return 'not checked';
  }
  if (!report.firmware.filePresent) {
    return 'not created yet';
  }
  if (!report.firmware.secretPresent) {
    return 'present but has no secret';
  }
  if (report.firmware.secretMatches === null) {
    return 'present (no Mac secret to compare)';
  }
  return report.firmware.secretMatches ? 'matches the Mac' : 'does not match the Mac';
}

function describeCodex(report: DoctorReport): string {
  if (!report.codex.executablePresent) {
    return 'not found';
  }
  if (report.codex.version !== null) {
    return `found, version ${report.codex.version}`;
  }
  return report.codex.versionTimedOut ? 'found, but it did not answer in time' : 'found, but it did not report a usable version';
}

function describeListener(report: DoctorReport): string {
  if (!report.listener.checked) {
    return 'not checked (address is not this Mac)';
  }
  if (report.listener.oldListener) {
    return 'an older listener answered (no /health report)';
  }
  if (!report.listener.reachable) {
    return report.listener.timedOut ? 'no answer in time' : 'not running';
  }
  const parts: string[] = [report.listener.companionStatus ?? `status ${report.listener.status ?? 'unknown'}`];
  if (report.listener.deviceConnected === true) {
    parts.push('device connected');
  } else if (report.listener.deviceConnected === false) {
    parts.push('no device connected');
  }
  if (report.listener.activeCalls !== null) {
    parts.push(`${report.listener.activeCalls} active call(s)`);
  }
  if (report.listener.lastError !== null) {
    parts.push(`last problem: ${report.listener.lastError.code}`);
  }
  return parts.join(', ');
}

function describeBoard(report: DoctorReport): string {
  if (!report.firmware.checked) {
    return 'not checked';
  }
  if (report.firmware.detectedBoard === null) {
    return 'no watch detected in the firmware folder';
  }
  const matches = report.firmware.deviceIdMatchesBoard;
  if (matches === false) {
    return `${report.firmware.detectedBoard} (device config names a different watch)`;
  }
  return report.firmware.detectedBoard;
}

export function renderDoctorText(report: DoctorReport): string {
  const lines = [
    `esp32 voice mode doctor - ${report.ok ? 'all good' : 'needs attention'}`,
    `  shared secret:   ${describeSecret(report)}`,
    `  watch:           ${describeBoard(report)}`,
  ];
  if (report.firmware.detectedBoard !== null) {
    lines.push(`  firmware build:   ${buildCommandForBoard(report.firmware.detectedBoard)}`);
  }
  lines.push(
    `  device config:   ${describeFirmware(report)}`,
    `  Codex:           ${describeCodex(report)}`,
    `  listener:        ${describeListener(report)}`,
  );
  if (report.warnings.length > 0) {
    lines.push('', 'What to look at:');
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
