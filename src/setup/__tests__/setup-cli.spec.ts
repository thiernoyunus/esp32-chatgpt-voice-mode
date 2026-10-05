import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setupMain } from '../setup-cli';

const GENERATED = 'cli-generated-secret-abcdefghijklmnop';

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'vm-setup-cli-'));
  const firmwareDir = join(root, 'firmware');
  mkdirSync(firmwareDir);
  return {
    root,
    firmwareDir,
    macFile: join(root, '.dev.vars'),
    firmwareFile: join(firmwareDir, 'sdkconfig.defaults.local'),
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    text: () => `${out.join('')}${err.join('')}`,
  };
}

function baseArguments(workspace: ReturnType<typeof makeWorkspace>): string[] {
  return ['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir, '--device-id', 'desk'];
}

describe('bun run setup, end to end', () => {
  it('writes a matching pair, privately, without printing the secret', async () => {
    const workspace = makeWorkspace();
    const io = capture();
    const code = await setupMain(baseArguments(workspace), {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
      randomSecret: () => GENERATED,
    });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('preview');
    const macSecret = readFileSync(workspace.macFile, 'utf8').match(/DEVICE_SHARED_SECRET=(\S+)/)?.[1];
    const deviceSecret = readFileSync(workspace.firmwareFile, 'utf8').match(/CONFIG_VOICEMODE_TOKEN="([^"]+)"/)?.[1];
    expect(macSecret).toBe(GENERATED);
    expect(deviceSecret).toBe(GENERATED);
    expect(statSync(workspace.macFile).mode & 0o777).toBe(0o600);
    expect(statSync(workspace.firmwareFile).mode & 0o777).toBe(0o600);
    expect(io.text()).not.toContain(GENERATED);
  });

  it('writes nothing on a dry run', async () => {
    const workspace = makeWorkspace();
    const io = capture();
    const code = await setupMain([...baseArguments(workspace), '--dry-run'], {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
      randomSecret: () => GENERATED,
    });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('Dry run');
    expect(existsSync(workspace.macFile)).toBe(false);
    expect(existsSync(workspace.firmwareFile)).toBe(false);
  });

  it('is idempotent: a second run leaves the existing files untouched', async () => {
    const workspace = makeWorkspace();
    const deps = {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: () => {},
      stderr: () => {},
      randomSecret: () => GENERATED,
    };
    await setupMain(baseArguments(workspace), deps);
    const macBefore = readFileSync(workspace.macFile, 'utf8');

    const io = capture();
    const code = await setupMain(baseArguments(workspace), { ...deps, stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('already in place');
    expect(readFileSync(workspace.macFile, 'utf8')).toBe(macBefore);
  });

  it('stops on a mismatched existing pair without changing either file', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, 'DEVICE_SHARED_SECRET=mac-side\n');
    writeFileSync(workspace.firmwareFile, 'CONFIG_VOICEMODE_TOKEN="device-side"\n');
    const io = capture();
    const code = await setupMain(baseArguments(workspace), {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('different secrets');
    expect(readFileSync(workspace.macFile, 'utf8')).toContain('mac-side');
    expect(readFileSync(workspace.firmwareFile, 'utf8')).toContain('device-side');
  });

  it('refuses to write interactively without a terminal, and stops when declined', async () => {
    const workspace = makeWorkspace();
    const io = capture();
    const deps = {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
      randomSecret: () => GENERATED,
    };
    const notTtyArgs = ['--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir];
    expect(await setupMain(notTtyArgs, { ...deps, isTty: false })).toBe(1);
    expect(existsSync(workspace.macFile)).toBe(false);

    const declined = await setupMain(notTtyArgs, {
      ...deps,
      isTty: true,
      confirm: async () => false,
    });
    expect(declined).toBe(1);
    expect(existsSync(workspace.macFile)).toBe(false);
  });

  it('rejects a bad port before doing anything', async () => {
    const io = capture();
    const code = await setupMain(['--port', '99999'], { stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(2);
  });

  it('rejects a port that only half-parses', async () => {
    const io = capture();
    const code = await setupMain(['--port', '123abc'], { stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(2);
    expect(io.err.join('')).toContain('Not a usable port');
  });

  it('stops on an incomplete existing Mac config instead of writing around it', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, 'DEVICE_SHARED_SECRET=\n');
    const io = capture();
    const code = await setupMain(baseArguments(workspace), {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
      randomSecret: () => GENERATED,
    });
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('no DEVICE_SHARED_SECRET');
    expect(existsSync(workspace.firmwareFile)).toBe(false);
  });

  it('never claims everything is in place when a requested target was not applied', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${GENERATED}\n`);
    writeFileSync(workspace.firmwareFile, [
      'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
      `CONFIG_VOICEMODE_TOKEN="${GENERATED}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="other"',
      '',
    ].join('\n'));
    const io = capture();
    const code = await setupMain(baseArguments(workspace), {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
      randomSecret: () => GENERATED,
    });
    expect(code).toBe(0);
    expect(io.out.join('')).not.toContain('already in place');
    expect(io.err.join('')).toContain('were not applied');
  });

  it('treats a blank --firmware-dir as no folder, never the current directory', async () => {
    const workspace = makeWorkspace();
    const io = capture();
    const code = await setupMain(['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', ''], {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile },
      workingDirectory: workspace.root,
      stdout: io.stdout,
      stderr: io.stderr,
      randomSecret: () => GENERATED,
    });
    expect(code).toBe(0);
    expect(existsSync(workspace.macFile)).toBe(true);
    expect(existsSync(join(workspace.root, 'sdkconfig.defaults.local'))).toBe(false);
    expect(io.err.join('')).toContain('--firmware-dir');
  });
});

describe('bun run setup, board-driven device id', () => {
  function addBoard(firmwareDir: string, boardId: string): void {
    const boardDir = join(firmwareDir, 'main', 'boards', 'waveshare', boardId);
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(join(boardDir, 'config.json'), `${JSON.stringify({ type: boardId })}\n`);
  }

  it('picks "desk" for the 1.85C when --device-id is not given', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-lcd-1.85c');
    const io = capture();
    const code = await setupMain(
      ['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    const written = readFileSync(workspace.firmwareFile, 'utf8');
    expect(written).toContain('CONFIG_VOICEMODE_DEVICE_ID="desk"');
    expect(io.out.join('')).toContain('esp32-s3-touch-lcd-1.85c');
  });

  it('picks "watch" for the AMOLED 2.06 when --device-id is not given', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
    const io = capture();
    const code = await setupMain(
      ['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    const written = readFileSync(workspace.firmwareFile, 'utf8');
    expect(written).toContain('CONFIG_VOICEMODE_DEVICE_ID="watch"');
    expect(io.out.join('')).toContain('esp32-s3-touch-amoled-2.06');
  });

  it('still honours --device-id on top of the detected board default', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
    const io = capture();
    const code = await setupMain(
      ['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir, '--device-id', 'workbench'],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    const written = readFileSync(workspace.firmwareFile, 'utf8');
    expect(written).toContain('CONFIG_VOICEMODE_DEVICE_ID="workbench"');
  });

  it('refuses to write when the firmware folder has no supported board', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-c6-touch-amoled-2.06');
    const io = capture();
    const code = await setupMain(
      ['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('no supported board');
    expect(existsSync(workspace.macFile)).toBe(false);
    expect(existsSync(workspace.firmwareFile)).toBe(false);
  });

  it('refuses to write when the firmware folder has both supported boards', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-lcd-1.85c');
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
    const io = capture();
    const code = await setupMain(
      ['--non-interactive', '--host', '192.168.1.20', '--firmware-dir', workspace.firmwareDir],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('more than one supported watch');
    expect(io.err.join('')).toContain('--board');
    expect(io.err.join('')).toContain('esp32-s3-touch-lcd-1.85c');
    expect(io.err.join('')).toContain('esp32-s3-touch-amoled-2.06');
    expect(existsSync(workspace.macFile)).toBe(false);
  });
});

describe('bun run setup, --board flag', () => {
  function addBoard(firmwareDir: string, boardId: string): void {
    const boardDir = join(firmwareDir, 'main', 'boards', 'waveshare', boardId);
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(join(boardDir, 'config.json'), `${JSON.stringify({ type: boardId })}\n`);
  }

  it('accepts the 1.85C and writes "desk" as the device id', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-lcd-1.85c');
    const io = capture();
    const code = await setupMain(
      [
        '--non-interactive', '--host', '192.168.1.20',
        '--firmware-dir', workspace.firmwareDir,
        '--board', 'esp32-s3-touch-lcd-1.85c',
      ],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    const written = readFileSync(workspace.firmwareFile, 'utf8');
    expect(written).toContain('CONFIG_VOICEMODE_DEVICE_ID="desk"');
  });

  it('accepts the AMOLED 2.06 and writes "watch" as the device id', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
    const io = capture();
    const code = await setupMain(
      [
        '--non-interactive', '--host', '192.168.1.20',
        '--firmware-dir', workspace.firmwareDir,
        '--board', 'esp32-s3-touch-amoled-2.06',
      ],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    const written = readFileSync(workspace.firmwareFile, 'utf8');
    expect(written).toContain('CONFIG_VOICEMODE_DEVICE_ID="watch"');
  });

  it('overrides a stale sdkconfig that names the other watch', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-lcd-1.85c');
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
    writeFileSync(join(workspace.firmwareDir, 'sdkconfig'),
      'CONFIG_BOARD_TYPE_WAVESHARE_ESP32_S3_TOUCH_LCD_1_85C=y\n');
    const io = capture();
    const code = await setupMain(
      [
        '--non-interactive', '--host', '192.168.1.20',
        '--firmware-dir', workspace.firmwareDir,
        '--board', 'esp32-s3-touch-amoled-2.06',
      ],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    const written = readFileSync(workspace.firmwareFile, 'utf8');
    expect(written).toContain('CONFIG_VOICEMODE_DEVICE_ID="watch"');
  });

  it('refuses a watch id that is not in the catalog', async () => {
    const workspace = makeWorkspace();
    const io = capture();
    const code = await setupMain(
      [
        '--non-interactive', '--host', '192.168.1.20',
        '--firmware-dir', workspace.firmwareDir,
        '--board', 'esp32-c6-touch-amoled-2.06',
      ],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('Unknown watch id');
    expect(io.err.join('')).toContain('esp32-s3-touch-lcd-1.85c');
    expect(io.err.join('')).toContain('esp32-s3-touch-amoled-2.06');
    expect(existsSync(workspace.macFile)).toBe(false);
  });

  it('prints the matching build command in the preview', async () => {
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
    const io = capture();
    const code = await setupMain(
      [
        '--non-interactive', '--host', '192.168.1.20',
        '--firmware-dir', workspace.firmwareDir,
        '--board', 'esp32-s3-touch-amoled-2.06',
      ],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('python3 firmware/scripts/build.py waveshare/esp32-s3-touch-amoled-2.06');
  });

  it('falls back to Kconfig default in the preview is no longer the path - ambiguous is reported', async () => {
    // The Kconfig default is the old LCD. If the firmware folder has both
    // boards and no trustworthy sdkconfig, --board is the only way forward.
    const workspace = makeWorkspace();
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-lcd-1.85c');
    addBoard(workspace.firmwareDir, 'esp32-s3-touch-amoled-2.06');
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
    writeFileSync(join(workspace.firmwareDir, 'main', 'Kconfig.projbuild'), kconfig);
    const io = capture();
    const code = await setupMain(
      [
        '--non-interactive', '--host', '192.168.1.20',
        '--firmware-dir', workspace.firmwareDir,
      ],
      {
        environment: { VOICEMODE_ENV_FILE: workspace.macFile },
        workingDirectory: workspace.root,
        stdout: io.stdout,
        stderr: io.stderr,
        randomSecret: () => GENERATED,
      },
    );
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('more than one supported watch');
    expect(io.err.join('')).toContain('--board');
  });
});
