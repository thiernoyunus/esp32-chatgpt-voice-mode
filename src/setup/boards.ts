/**
 * Which hardware the firmware folder was written for, and the device id that
 * hardware should report by default.
 *
 * Two boards are supported. The list lives here, in the Mac companion, not in
 * the firmware repo: the firmware's own build script reads
 * `main/boards/waveshare/<board>/config.json`, so the same directory layout
 * is the source of truth for "is this firmware for board X?". A board id is
 * the directory name (for example `esp32-s3-touch-lcd-1.85c`), which is also
 * the value of the `type` key inside that config.json.
 *
 * The default device id per board is set here, not read from the firmware,
 * so a fresh clone of either watch is reachable as soon as `bun run setup`
 * finishes. `--device-id` still wins; an existing device config still wins
 * over the catalog default, so a hand-rolled id is never overwritten.
 *
 * Detection is layered and explicit. The user can always say which board
 * with `--board`, and that wins. Without it, detection trusts the firmware's
 * own state: a single supported board in `main/boards/waveshare/` is
 * authoritative, and an `sdkconfig` that names a board actually present in
 * that directory is also authoritative. When both supported boards are
 * present and no trustworthy signal exists, detection refuses to guess and
 * asks for `--board` - the Kconfig default is the old LCD, so falling back
 * to it would silently mis-detect AMOLED users.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BOARD_LCD_1_85C = 'esp32-s3-touch-lcd-1.85c';
export const BOARD_AMOLED_2_06 = 'esp32-s3-touch-amoled-2.06';

/**
 * The boards this companion recognises, with the device id each should
 * announce by default. The list is closed: a firmware folder built for a
 * board not in this catalog is treated as unsupported, never as a guess.
 */
export const SUPPORTED_BOARDS: Readonly<Record<string, { readonly defaultDeviceId: string }>> = {
  [BOARD_LCD_1_85C]: { defaultDeviceId: 'desk' },
  [BOARD_AMOLED_2_06]: { defaultDeviceId: 'watch' },
};

/**
 * When the firmware folder is missing, the user did not opt in, and there is
 * no device config to copy from, fall back to the historic default. Picking
 * one is required for the prompt to be readable.
 */
export const FALLBACK_DEFAULT_DEVICE_ID = 'desk';

export const BOARDS_DIR_RELATIVE = join('main', 'boards', 'waveshare');

export const SDKCONFIG_RELATIVE = 'sdkconfig';

/**
 * The exact command the firmware's `scripts/build.py` expects, with the
 * board id appended. Surfaced in the setup preview so the user knows what
 * to run on the firmware side to match what they just told the Mac.
 */
export const BUILD_COMMAND_PREFIX = 'python3 firmware/scripts/build.py waveshare/';

export function buildCommandForBoard(board: string): string {
  return `${BUILD_COMMAND_PREFIX}${board}`;
}

/**
 * Mapping from the Kconfig symbol each supported board uses in `sdkconfig`
 * to the catalog id. The catalog id is what the firmware's own boards
 * directory names the same hardware, so the mapping is the contract that
 * lets the companion agree with the firmware.
 */
const BOARD_TYPE_SYMBOLS: Readonly<Record<string, string>> = {
  CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85C: BOARD_LCD_1_85C,
  CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_2_06: BOARD_AMOLED_2_06,
};

export type BoardDetectionSource = 'boards-dir' | 'sdkconfig' | 'requested';

export type BoardDetection =
  | { readonly state: 'one'; readonly board: string; readonly source: BoardDetectionSource }
  | { readonly state: 'none' }
  | { readonly state: 'unsupported'; readonly found: readonly string[] }
  | { readonly state: 'ambiguous'; readonly found: readonly string[]; readonly sdkconfigTrusted: boolean }
  | { readonly state: 'unreadable'; readonly reason: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readBoardType(boardDir: string): string | null {
  const configPath = join(boardDir, 'config.json');
  if (!isRegularFile(configPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { type?: unknown };
    return typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : null;
  } catch {
    return null;
  }
}

/**
 * Read the firmware's own boards directory and return the supported boards
 * it actually carries. Reads only the file the firmware's build script
 * reads, so the companion cannot disagree with the firmware about what is
 * inside the checkout.
 */
function listSupportedBoardsInDir(firmwareDir: string): {
  recognised: string[];
  unrecognised: string[];
} {
  const boardsDir = join(firmwareDir, BOARDS_DIR_RELATIVE);
  if (!isDirectory(boardsDir)) {
    return { recognised: [], unrecognised: [] };
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(boardsDir);
  } catch {
    return { recognised: [], unrecognised: [] };
  }
  const recognised: string[] = [];
  const unrecognised: string[] = [];
  for (const entry of entries) {
    if (!isDirectory(join(boardsDir, entry))) {
      continue;
    }
    const declared = readBoardType(join(boardsDir, entry));
    if (declared !== null && Object.prototype.hasOwnProperty.call(SUPPORTED_BOARDS, declared)) {
      if (!recognised.includes(declared)) {
        recognised.push(declared);
      }
    } else {
      unrecognised.push(entry);
    }
  }
  return { recognised, unrecognised };
}

/**
 * Read the `CONFIG_BOARD_TYPE_*=y` line that names the active board in
 * `sdkconfig` (the output of a build). The line is the only signal setup
 * can trust, because nothing else in `sdkconfig` ties back to the boards
 * directory. An empty or missing value is treated as "no signal".
 */
function readBoardSymbolInSdkconfig(firmwareDir: string): string | null {
  const sdkconfigPath = join(firmwareDir, SDKCONFIG_RELATIVE);
  if (!isRegularFile(sdkconfigPath)) {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(sdkconfigPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.startsWith('CONFIG_BOARD_TYPE_')) {
      continue;
    }
    const match = trimmed.match(/^(CONFIG_BOARD_TYPE_[A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match === null) {
      continue;
    }
    const symbol = match[1];
    const value = match[2];
    if (value === 'y' && symbol !== undefined) {
      return symbol;
    }
  }
  return null;
}

function symbolToBoard(symbol: string): string | null {
  return BOARD_TYPE_SYMBOLS[symbol] ?? null;
}

export function isSupportedBoard(board: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_BOARDS, board);
}

export function defaultDeviceIdForBoard(board: string): string {
  const entry = SUPPORTED_BOARDS[board];
  return entry?.defaultDeviceId ?? FALLBACK_DEFAULT_DEVICE_ID;
}

/**
 * Validate a `--board` value the user typed. `null`/`undefined`/empty is
 * "not given" and not an error; the caller decides what to do. A real
 * value is an error if it is not in the closed catalog, because the
 * companion cannot produce a default device id or a build command for an
 * unknown watch and silently picking one is exactly the bug the user
 * asked us to fix.
 */
export function validateBoardId(board: string | null | undefined): string | null {
  if (board === undefined || board === null || board.length === 0) {
    return null;
  }
  if (!isSupportedBoard(board)) {
    const known = Object.keys(SUPPORTED_BOARDS).join(', ');
    return `Unknown watch id "${board}". Pass --board with one of: ${known}.`;
  }
  return null;
}

/**
 * Read the firmware folder and decide which supported board it is for.
 *
 * The detection layers, in order:
 *
 *   1. If the caller passed a `--board` value, that wins outright. It
 *      overrides the firmware's own state, so a stale `sdkconfig` left
 *      over from a different machine cannot silently pick the wrong
 *      default device id.
 *   2. If `main/boards/waveshare/` contains exactly one supported board,
 *      that is the answer. The firmware's own build script reads the same
 *      directory, so this cannot disagree with what a build would pick.
 *   3. If both supported boards are present, fall back to `sdkconfig`,
 *      but only when it names a board that is actually present in that
 *      directory. A `sdkconfig` that points elsewhere (older checkout,
 *      different machine) is not trustworthy, because the user could
 *      easily flash the wrong firmware and only notice later.
 *   4. Otherwise, refuse to pick: return `ambiguous` so the caller can
 *      ask for `--board` instead of guessing. The Kconfig default is the
 *      old LCD, so a silent fallback to it would mis-detect AMOLED users.
 *
 * `--board` validation is the caller's job (`validateBoardId`); this
 * function assumes the value, when present, is already known to be in
 * the catalog.
 */
export function detectBoard(
  firmwareDir: string | null,
  requestedBoard: string | null | undefined = null,
): BoardDetection {
  if (requestedBoard !== null && requestedBoard !== undefined && requestedBoard.length > 0) {
    return { state: 'one', board: requestedBoard, source: 'requested' };
  }
  if (firmwareDir === null) {
    return { state: 'none' };
  }
  const resolved = resolve(firmwareDir);
  const { recognised, unrecognised } = listSupportedBoardsInDir(resolved);
  if (recognised.length === 1) {
    return { state: 'one', board: recognised[0] as string, source: 'boards-dir' };
  }
  if (recognised.length > 1) {
    const sdkconfigSymbol = readBoardSymbolInSdkconfig(resolved);
    const sdkconfigBoard = sdkconfigSymbol === null ? null : symbolToBoard(sdkconfigSymbol);
    const sdkconfigTrusted = sdkconfigBoard !== null && recognised.includes(sdkconfigBoard);
    if (sdkconfigTrusted && sdkconfigBoard !== null) {
      return { state: 'one', board: sdkconfigBoard, source: 'sdkconfig' };
    }
    return {
      state: 'ambiguous',
      found: recognised,
      sdkconfigTrusted,
    };
  }
  if (unrecognised.length > 0) {
    return { state: 'unsupported', found: unrecognised };
  }
  return { state: 'none' };
}
