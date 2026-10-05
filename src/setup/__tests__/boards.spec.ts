import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOARD_AMOLED_2_06,
  BOARD_LCD_1_85C,
  BUILD_COMMAND_PREFIX,
  buildCommandForBoard,
  defaultDeviceIdForBoard,
  detectBoard,
  isSupportedBoard,
  FALLBACK_DEFAULT_DEVICE_ID,
  SUPPORTED_BOARDS,
  validateBoardId,
} from '../boards';

const BOARDS_DIR = ['main', 'boards', 'waveshare'];

function makeFirmware(): string {
  return mkdtempSync(join(tmpdir(), 'vm-boards-'));
}

function addBoard(firmwareDir: string, boardId: string): void {
  const boardDir = join(firmwareDir, ...BOARDS_DIR, boardId);
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(join(boardDir, 'config.json'), `${JSON.stringify({ type: boardId })}\n`);
}

function writeSdkconfig(firmwareDir: string, line: string): void {
  writeFileSync(join(firmwareDir, 'sdkconfig'), `${line}\n`);
}

function rmSyncRecursive(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe('the supported board catalog', () => {
  it('names the two waveshare watches the companion knows about', () => {
    expect(Object.keys(SUPPORTED_BOARDS).sort()).toEqual(
      [BOARD_LCD_1_85C, BOARD_AMOLED_2_06].sort(),
    );
  });

  it('assigns a distinct default device id to each watch', () => {
    expect(defaultDeviceIdForBoard(BOARD_LCD_1_85C)).toBe('desk');
    expect(defaultDeviceIdForBoard(BOARD_AMOLED_2_06)).toBe('watch');
    const defaults = new Set([
      defaultDeviceIdForBoard(BOARD_LCD_1_85C),
      defaultDeviceIdForBoard(BOARD_AMOLED_2_06),
    ]);
    expect(defaults.size).toBe(2);
  });

  it('falls back to the historic default for an unknown board, so the prompt is readable', () => {
    expect(defaultDeviceIdForBoard('not-a-real-board')).toBe(FALLBACK_DEFAULT_DEVICE_ID);
  });

  it('isSupportedBoard answers only for the catalog entries', () => {
    expect(isSupportedBoard(BOARD_LCD_1_85C)).toBe(true);
    expect(isSupportedBoard(BOARD_AMOLED_2_06)).toBe(true);
    expect(isSupportedBoard('esp32-c6-touch-amoled-2.06')).toBe(false);
  });
});

describe('the build command the preview prints', () => {
  it('uses the firmware build script with the waveshare/ prefix', () => {
    expect(BUILD_COMMAND_PREFIX).toBe('python3 firmware/scripts/build.py waveshare/');
    expect(buildCommandForBoard(BOARD_LCD_1_85C)).toBe(
      'python3 firmware/scripts/build.py waveshare/esp32-s3-touch-lcd-1.85c',
    );
    expect(buildCommandForBoard(BOARD_AMOLED_2_06)).toBe(
      'python3 firmware/scripts/build.py waveshare/esp32-s3-touch-amoled-2.06',
    );
  });
});

describe('validating a --board value', () => {
  it('returns no error when the value is not given', () => {
    expect(validateBoardId(undefined)).toBeNull();
    expect(validateBoardId(null)).toBeNull();
    expect(validateBoardId('')).toBeNull();
  });

  it('returns no error for a catalog id', () => {
    expect(validateBoardId(BOARD_LCD_1_85C)).toBeNull();
    expect(validateBoardId(BOARD_AMOLED_2_06)).toBeNull();
  });

  it('refuses an unknown watch id and lists the catalog', () => {
    const error = validateBoardId('esp32-c6-touch-amoled-2.06');
    expect(error).not.toBeNull();
    expect(error).toContain('esp32-c6-touch-amoled-2.06');
    expect(error).toContain(BOARD_LCD_1_85C);
    expect(error).toContain(BOARD_AMOLED_2_06);
  });
});

describe('detecting a single supported board', () => {
  it('finds the 1.85C when the firmware folder only holds that board', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_LCD_1_85C);
        expect(detection.source).toBe('boards-dir');
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('finds the AMOLED 2.06 when the firmware folder only holds that board', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_AMOLED_2_06);
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_AMOLED_2_06);
        expect(detection.source).toBe('boards-dir');
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('trusts the type field over the directory name, so a renamed folder cannot lie', () => {
    const firmwareDir = makeFirmware();
    try {
      mkdirSync(join(firmwareDir, ...BOARDS_DIR, 'round-thing'), { recursive: true });
      writeFileSync(
        join(firmwareDir, ...BOARDS_DIR, 'round-thing', 'config.json'),
        `${JSON.stringify({ type: BOARD_LCD_1_85C })}\n`,
      );
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_LCD_1_85C);
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });
});

describe('an explicit --board overrides everything', () => {
  it('wins even when the firmware folder only carries the other watch', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      const detection = detectBoard(firmwareDir, BOARD_AMOLED_2_06);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_AMOLED_2_06);
        expect(detection.source).toBe('requested');
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('wins when the firmware folder is missing entirely', () => {
    const detection = detectBoard(null, BOARD_LCD_1_85C);
    expect(detection.state).toBe('one');
    if (detection.state === 'one') {
      expect(detection.board).toBe(BOARD_LCD_1_85C);
      expect(detection.source).toBe('requested');
    }
  });

  it('wins over a stale sdkconfig that points at the other watch', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      addBoard(firmwareDir, BOARD_AMOLED_2_06);
      writeSdkconfig(firmwareDir, 'CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85C=y');
      const detection = detectBoard(firmwareDir, BOARD_AMOLED_2_06);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_AMOLED_2_06);
        expect(detection.source).toBe('requested');
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });
});

describe('detecting when both supported boards are present', () => {
  it('trusts sdkconfig when it names a board that is actually present', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      addBoard(firmwareDir, BOARD_AMOLED_2_06);
      writeSdkconfig(firmwareDir, 'CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_2_06=y');
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_AMOLED_2_06);
        expect(detection.source).toBe('sdkconfig');
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('returns ambiguous with sdkconfigTrusted=false when sdkconfig is absent', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      addBoard(firmwareDir, BOARD_AMOLED_2_06);
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('ambiguous');
      if (detection.state === 'ambiguous') {
        expect(detection.sdkconfigTrusted).toBe(false);
        expect([...detection.found].sort()).toEqual([BOARD_LCD_1_85C, BOARD_AMOLED_2_06].sort());
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('returns ambiguous with sdkconfigTrusted=false when sdkconfig names a board not in the catalog', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      addBoard(firmwareDir, BOARD_AMOLED_2_06);
      writeSdkconfig(firmwareDir, 'CONFIG_BOARD_TYPE_FUTURE_WATCH=y');
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('ambiguous');
      if (detection.state === 'ambiguous') {
        expect(detection.sdkconfigTrusted).toBe(false);
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('never falls back to the Kconfig default, because the Kconfig default is the old LCD', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      addBoard(firmwareDir, BOARD_AMOLED_2_06);
      const kconfig = [
        'choice BOARD_TYPE',
        '    default BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85C',
        '    config BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85C',
        '        bool "Waveshare ESP32-S3-Touch-LCD-1.85C"',
        '    config BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_AMOLED_2_06',
        '        bool "Waveshare ESP32-S3-Touch-AMOLED-2.06"',
        'endchoice',
        '',
      ].join('\n');
      writeFileSync(join(firmwareDir, 'main', 'Kconfig.projbuild'), kconfig);
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('ambiguous');
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });
});

describe('detecting in missing or unsupported folders', () => {
  it('reports none when no firmware folder was given', () => {
    expect(detectBoard(null)).toEqual({ state: 'none' });
  });

  it('reports none when the boards directory is missing entirely', () => {
    const firmwareDir = makeFirmware();
    try {
      expect(detectBoard(firmwareDir)).toEqual({ state: 'none' });
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('reports unsupported when only a board this companion does not recognise is present', () => {
    const firmwareDir = makeFirmware();
    try {
      addBoard(firmwareDir, 'esp32-c6-touch-amoled-2.06');
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('unsupported');
      if (detection.state === 'unsupported') {
        expect(detection.found).toEqual(['esp32-c6-touch-amoled-2.06']);
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('skips entries that are files, not directories', () => {
    const firmwareDir = makeFirmware();
    try {
      const boardsDir = join(firmwareDir, ...BOARDS_DIR);
      mkdirSync(boardsDir, { recursive: true });
      writeFileSync(join(boardsDir, 'readme.md'), 'not a board');
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_LCD_1_85C);
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('skips a board directory whose config.json cannot be parsed', () => {
    const firmwareDir = makeFirmware();
    try {
      const broken = join(firmwareDir, ...BOARDS_DIR, 'broken');
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, 'config.json'), '{ this is not json');
      addBoard(firmwareDir, BOARD_LCD_1_85C);
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('one');
      if (detection.state === 'one') {
        expect(detection.board).toBe(BOARD_LCD_1_85C);
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });

  it('returns unsupported with the broken entry when no good board is present', () => {
    const firmwareDir = makeFirmware();
    try {
      const broken = join(firmwareDir, ...BOARDS_DIR, 'broken');
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, 'config.json'), '{ this is not json');
      const detection = detectBoard(firmwareDir);
      expect(detection.state).toBe('unsupported');
      if (detection.state === 'unsupported') {
        expect(detection.found).toEqual(['broken']);
      }
    } finally {
      rmSyncRecursive(firmwareDir);
    }
  });
});
