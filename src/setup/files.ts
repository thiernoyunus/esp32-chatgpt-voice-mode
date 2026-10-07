/**
 * Reading and writing the two files that must carry the same secret:
 *
 *   - the Mac's `.dev.vars`, which the listener reads at startup, and
 *   - the firmware's `sdkconfig.defaults.local`, which is baked into the
 *     device when it is built.
 *
 * Both are private, machine-specific and gitignored. Nothing here ever prints
 * a secret; the value travels between the two files and nowhere else.
 */
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { generateSharedSecret, parseDevelopmentVariableMap } from '../vars';

export const MAC_ENV_FILE_NAME = '.dev.vars';
export const FIRMWARE_CONFIG_FILE_NAME = 'sdkconfig.defaults.local';
export const MAC_SECRET_KEY = 'DEVICE_SHARED_SECRET';
export const FIRMWARE_SECRET_KEY = 'CONFIG_VOICEMODE_TOKEN';
export const FIRMWARE_URL_KEY = 'CONFIG_VOICEMODE_URL';
export const FIRMWARE_DEVICE_ID_KEY = 'CONFIG_VOICEMODE_DEVICE_ID';
export const DEFAULT_DEVICE_ID = 'desk';
export const DEFAULT_LISTENER_PORT = 8790;
export const PRIVATE_FILE_MODE = 0o600;
/** The old two-repository layout is still accepted for existing installs. */
export const SIBLING_FIRMWARE_FOLDER = 'esp32-chatgpt-voice-mode-firmware';

/** Where the secret for a generated pair came from. */
export type SecretSource = 'environment' | 'env-file' | 'firmware' | 'generated';

export type FirmwareSettings = {
  readonly token: string | null;
  readonly url: string | null;
  readonly deviceId: string | null;
};

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(directoryPath: string): boolean {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

/** The env file the listener will read, honouring VOICEMODE_ENV_FILE. */
export function macEnvFilePathFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.VOICEMODE_ENV_FILE?.trim();
  return configured !== undefined && configured.length > 0 ? resolve(configured) : resolve(MAC_ENV_FILE_NAME);
}

function unquote(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readConfigValue(content: string, key: string): string | null {
  const matcher = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('#')) {
      continue;
    }
    const match = line.match(matcher);
    if (match?.[1] === undefined) {
      continue;
    }
    const value = unquote(match[1]);
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Pull only the three settings setup cares about out of a firmware file. */
export function parseFirmwareSettings(content: string): FirmwareSettings {
  return {
    token: readConfigValue(content, FIRMWARE_SECRET_KEY),
    url: readConfigValue(content, FIRMWARE_URL_KEY),
    deviceId: readConfigValue(content, FIRMWARE_DEVICE_ID_KEY),
  };
}

export function readFirmwareSettings(filePath: string): FirmwareSettings | null {
  if (!isRegularFile(filePath)) {
    return null;
  }
  return parseFirmwareSettings(readFileSync(filePath, 'utf8'));
}

/**
 * The Mac's secret, read the same way the listener reads it (readDeviceToken):
 * VOICEMODE_DEVICE_SECRET wins whenever it is set, even when it is empty -
 * an explicitly empty override is a hard failure, not a fall back to the file.
 * The override is used verbatim; the env file's value is already trimmed by
 * the shared parser.
 */
export type MacSecretRead =
  | { readonly state: 'present'; readonly secret: string; readonly source: 'environment' | 'env-file' }
  | { readonly state: 'empty-override' }
  | { readonly state: 'missing' };

export function readMacSecret(
  environment: NodeJS.ProcessEnv,
  envFileContent: string | null,
): MacSecretRead {
  const override = environment.VOICEMODE_DEVICE_SECRET;
  if (override !== undefined) {
    return override.length === 0
      ? { state: 'empty-override' }
      : { state: 'present', secret: override, source: 'environment' };
  }
  if (envFileContent !== null) {
    const fromFile = parseDevelopmentVariableMap(envFileContent).get(MAC_SECRET_KEY);
    if (fromFile !== undefined && fromFile.length > 0) {
      return { state: 'present', secret: fromFile, source: 'env-file' };
    }
  }
  return { state: 'missing' };
}

export function buildMacEnvFileContent(secret: string): string {
  return [
    '# Written by `bun run setup`. Gitignored; never commit it.',
    '#',
    '# The device must be built with the same value in CONFIG_VOICEMODE_TOKEN.',
    '# To rotate it, delete this file and the firmware sdkconfig.defaults.local,',
    '# then run `bun run setup` again.',
    '',
    `${MAC_SECRET_KEY}=${secret}`,
    '',
    '# These are passed to ./scripts/install-service.sh, not read from this file:',
    '#   VOICEMODE_CODEX_MODEL        pin a Codex model for calls',
    '#   VOICEMODE_CODEX_REASONING_EFFORT override Codex reasoning for calls',
    '#   VOICEMODE_CODEX_DISABLE_MCP  comma-separated MCP servers to switch off',
    '#   VOICEMODE_CODEX_BIN          path to the codex binary, if not the bundled one',
    '#   VOICEMODE_CODEX_ROOT         absolute folder for new voice chats',
    '',
  ].join('\n');
}

export function buildFirmwareFileContent(input: {
  readonly secret: string;
  readonly host: string;
  readonly port: number;
  readonly deviceId: string;
}): string {
  return [
    '# Written by `bun run setup`. Gitignored; never commit it.',
    `# The token must match ${MAC_SECRET_KEY} in the Mac's .dev.vars.`,
    '',
    `${FIRMWARE_URL_KEY}="ws://${input.host}:${input.port}"`,
    `${FIRMWARE_SECRET_KEY}="${input.secret}"`,
    `${FIRMWARE_DEVICE_ID_KEY}="${input.deviceId}"`,
    '',
  ].join('\n');
}

/**
 * Create a file that did not exist, readable and writable only by this user.
 * The exclusive flag is the point: an existing file is never touched, so a
 * secret someone already relies on cannot be silently replaced.
 */
export function writePrivateFileExclusive(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
}

export function removeFileQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone, or never written; rollback is best-effort by design.
  }
}

export function privateFileModeLabel(filePath: string): '0600' | 'other' | 'absent' {
  try {
    const mode = statSync(filePath).mode & 0o777;
    return mode === PRIVATE_FILE_MODE ? '0600' : 'other';
  } catch {
    return 'absent';
  }
}

/** Explicit flag wins, then VOICEMODE_FIRMWARE_DIR, then this checkout. */
export function detectFirmwareDir(
  workingDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = environment.VOICEMODE_FIRMWARE_DIR?.trim();
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured);
  }
  const local = resolve(workingDirectory, 'firmware');
  if (isDirectory(local)) {
    return local;
  }
  const sibling = resolve(workingDirectory, '..', SIBLING_FIRMWARE_FOLDER);
  return isDirectory(sibling) ? sibling : null;
}

export function firmwareConfigPath(firmwareDir: string): string {
  return join(firmwareDir, FIRMWARE_CONFIG_FILE_NAME);
}

/**
 * The firmware's resolved build output. This is what the device actually
 * runs with after a build: it merges the project's `sdkconfig.defaults`,
 * the user's `sdkconfig.defaults.local`, and the selected board's
 * `sdkconfig_append`, with later sources overriding earlier ones. When it
 * exists, the `CONFIG_VOICEMODE_DEVICE_ID` it carries is the value the
 * device will report, regardless of what the local override file holds.
 */
export const SDKCONFIG_GENERATED_FILE_NAME = 'sdkconfig';

export function generatedFirmwareConfigPath(firmwareDir: string): string {
  return join(firmwareDir, SDKCONFIG_GENERATED_FILE_NAME);
}

export type EffectiveDeviceIdSource = 'generated' | 'local' | 'none';

export type EffectiveDeviceId = {
  readonly source: EffectiveDeviceIdSource;
  readonly deviceId: string | null;
};

/**
 * The device id the firmware will actually report after a build.
 *
 * The generated `sdkconfig` is the resolved output of the last build and
 * is authoritative when it names a device id: the user can deliberately
 * keep an old value in `sdkconfig.defaults.local` for a board whose build
 * fragment overrides it, and the generated file carries the value the
 * device will see. The local file is the source of truth only when no
 * build has been run yet (or the build did not set the value), so a
 * fresh checkout with only the local override still works.
 */
export function readEffectiveDeviceId(firmwareDir: string): EffectiveDeviceId {
  const generated = readFirmwareSettings(generatedFirmwareConfigPath(firmwareDir));
  if (generated !== null && generated.deviceId !== null) {
    return { source: 'generated', deviceId: generated.deviceId };
  }
  const local = readFirmwareSettings(firmwareConfigPath(firmwareDir));
  if (local !== null && local.deviceId !== null) {
    return { source: 'local', deviceId: local.deviceId };
  }
  return { source: 'none', deviceId: null };
}

export function createSharedSecret(): string {
  return generateSharedSecret();
}

export function readTextFile(filePath: string): string | null {
  return isRegularFile(filePath) ? readFileSync(filePath, 'utf8') : null;
}
