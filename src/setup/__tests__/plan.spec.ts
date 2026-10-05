import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applySetupPlan, buildSetupPlan, buildSetupPreview } from '../plan';

function detectionForBoard(board: string | null) {
  return (_: string | null, requestedBoard: string | null = null) => {
    // The real detector honours `--board` first; tests usually don't pass
    // one, so this falls through to the canned answer.
    if (requestedBoard !== null && requestedBoard.length > 0) {
      return { state: 'one' as const, board: requestedBoard, source: 'requested' as const };
    }
    return board === null
      ? { state: 'none' as const }
      : { state: 'one' as const, board, source: 'boards-dir' as const };
  };
}

function unsupportedDetection(found: readonly string[]) {
  return (_: string | null, requestedBoard: string | null = null) => {
    if (requestedBoard !== null && requestedBoard.length > 0) {
      return { state: 'one' as const, board: requestedBoard, source: 'requested' as const };
    }
    return { state: 'unsupported' as const, found };
  };
}

function ambiguousDetection(
  found: readonly string[],
  sdkconfigTrusted: boolean,
) {
  return (_: string | null, requestedBoard: string | null = null) => {
    if (requestedBoard !== null && requestedBoard.length > 0) {
      return { state: 'one' as const, board: requestedBoard, source: 'requested' as const };
    }
    return { state: 'ambiguous' as const, found, sdkconfigTrusted };
  };
}

const GENERATED = 'generated-secret-abcdefghijklmnop';
const EXISTING_MAC = 'existing-mac-secret';
const EXISTING_DEVICE = 'existing-device-secret';

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'vm-plan-'));
  const firmwareDir = join(root, 'firmware');
  mkdirSync(firmwareDir);
  return {
    root,
    firmwareDir,
    macFile: join(root, '.dev.vars'),
    firmwareFile: join(firmwareDir, 'sdkconfig.defaults.local'),
  };
}

function planFor(
  workspace: ReturnType<typeof makeWorkspace>,
  overrides: Partial<Parameters<typeof buildSetupPlan>[0]> = {},
) {
  return buildSetupPlan({
    environment: {},
    macEnvFilePath: workspace.macFile,
    firmwareDir: workspace.firmwareDir,
    host: '192.168.1.20',
    port: 8790,
    deviceId: 'desk',
    randomSecret: () => GENERATED,
    ...overrides,
  });
}

function fileOf(plan: ReturnType<typeof buildSetupPlan>, kind: 'mac' | 'firmware') {
  const file = plan.files.find((candidate) => candidate.kind === kind);
  if (file === undefined) throw new Error(`no ${kind} file planned`);
  return file;
}

describe('pairing the two secrets', () => {
  it('generates one secret and writes it to both sides when neither exists', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace);
    expect(plan.errors).toEqual([]);
    expect(plan.secretSource).toBe('generated');
    expect(fileOf(plan, 'mac').content).toContain(`DEVICE_SHARED_SECRET=${GENERATED}`);
    expect(fileOf(plan, 'firmware').content).toContain(`CONFIG_VOICEMODE_TOKEN="${GENERATED}"`);
  });

  it('reuses the existing Mac secret for the device, and leaves the Mac file alone', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${EXISTING_MAC}\n# keep me\n`);
    const plan = planFor(workspace);
    expect(plan.secretSource).toBe('env-file');
    expect(fileOf(plan, 'mac').action).toBe('keep');
    expect(fileOf(plan, 'firmware').content).toContain(`CONFIG_VOICEMODE_TOKEN="${EXISTING_MAC}"`);
    applySetupPlan(plan);
    expect(readFileSync(workspace.macFile, 'utf8')).toContain('# keep me');
  });

  it('reuses the existing device secret when only the device is configured', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.firmwareFile, `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"\n`);
    const plan = planFor(workspace);
    expect(plan.secretSource).toBe('firmware');
    expect(fileOf(plan, 'mac').content).toContain(`DEVICE_SHARED_SECRET=${EXISTING_DEVICE}`);
    expect(fileOf(plan, 'firmware').action).toBe('keep');
  });

  it('does nothing when both already match', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${EXISTING_MAC}\n`);
    writeFileSync(workspace.firmwareFile, `CONFIG_VOICEMODE_TOKEN="${EXISTING_MAC}"\n`);
    const plan = planFor(workspace);
    expect(plan.errors).toEqual([]);
    expect(fileOf(plan, 'mac').action).toBe('keep');
    expect(fileOf(plan, 'firmware').action).toBe('keep');
    expect(applySetupPlan(plan).created).toEqual([]);
  });

  it('refuses to pick a winner when the two existing secrets differ', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${EXISTING_MAC}\n`);
    writeFileSync(workspace.firmwareFile, `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"\n`);
    const plan = planFor(workspace);
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(() => applySetupPlan(plan)).toThrow();
    expect(readFileSync(workspace.macFile, 'utf8')).toContain(EXISTING_MAC);
    expect(readFileSync(workspace.firmwareFile, 'utf8')).toContain(EXISTING_DEVICE);
  });
});

describe('incomplete existing files are problems, not guesses', () => {
  it('refuses to build around a Mac file that has no secret', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, 'DEVICE_SHARED_SECRET=\n');
    const plan = planFor(workspace);
    expect(plan.errors.some((error) => error.includes('has no DEVICE_SHARED_SECRET'))).toBe(true);
    expect(() => applySetupPlan(plan)).toThrow();
    expect(existsSync(workspace.firmwareFile)).toBe(false);
  });

  it('refuses to build around a device file that has no token', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.firmwareFile, 'this is not a valid config\n');
    const plan = planFor(workspace);
    expect(plan.errors.some((error) => error.includes('no CONFIG_VOICEMODE_TOKEN'))).toBe(true);
    expect(existsSync(workspace.macFile)).toBe(false);
  });

  it('allows the Mac file to stay secret-less when the environment supplies one', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, 'DEVICE_SHARED_SECRET=\n');
    const plan = planFor(workspace, { environment: { VOICEMODE_DEVICE_SECRET: EXISTING_MAC } });
    expect(plan.errors).toEqual([]);
    expect(plan.secretSource).toBe('environment');
    expect(fileOf(plan, 'firmware').content).toContain(`CONFIG_VOICEMODE_TOKEN="${EXISTING_MAC}"`);
  });

  it('keeps a previously generated device file byte for byte, extras included', () => {
    const workspace = makeWorkspace();
    const original = [
      'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
      'CONFIG_VOICEMODE_TOKEN="e3LIJkkNm80Yg3zu3ke1LlDS6g7jdZGWgIWjugWtRDY"',
      'CONFIG_VOICEMODE_DEVICE_ID="desk"',
      'CONFIG_USE_DEVICE_AEC=y',
      'CONFIG_VOICEMODE_CODEX_VOICE=y',
      '',
    ].join('\n');
    writeFileSync(workspace.firmwareFile, original);
    const plan = planFor(workspace);
    applySetupPlan(plan);
    expect(readFileSync(workspace.firmwareFile, 'utf8')).toBe(original);
    expect(fileOf(plan, 'firmware').action).toBe('keep');
  });
});

describe('values that would corrupt a config file are refused', () => {
  it('rejects addresses that are more than a host name or IP', () => {
    const workspace = makeWorkspace();
    for (const host of ['ws://192.168.1.20', '192.168.1.20:8790', '192.168.1.20/room', 'user@192.168.1.20', 'a b']) {
      const plan = planFor(workspace, { host });
      expect(plan.errors.length).toBeGreaterThan(0);
    }
    expect(planFor(workspace, { host: '' }).errors.length).toBeGreaterThan(0);
    expect(planFor(makeWorkspace(), { host: '192.168.1.20' }).errors).toEqual([]);
  });

  it('rejects a secret or device id carrying quotes, backslashes, or newlines', () => {
    const workspace = makeWorkspace();
    const quoted = planFor(workspace, { environment: { VOICEMODE_DEVICE_SECRET: 'abc"def' } });
    expect(quoted.errors.some((error) => error.includes('shared secret'))).toBe(true);

    const newlined = planFor(workspace, { deviceId: 'desk\nCONFIG_X=y' });
    expect(newlined.errors.some((error) => error.includes('device id'))).toBe(true);

    const backslashed = planFor(workspace, { environment: { VOICEMODE_DEVICE_SECRET: 'abc\\def' } });
    expect(backslashed.errors.some((error) => error.includes('shared secret'))).toBe(true);
  });

  it('never echoes a rejected secret in the error text', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, { environment: { VOICEMODE_DEVICE_SECRET: 'veryprivate"value' } });
    expect(plan.errors.join(' ')).not.toContain('veryprivate');
  });
});

describe('telling the truth about a device file that stays as it is', () => {
  it('says which requested settings were not applied', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.firmwareFile, [
      'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
      `CONFIG_VOICEMODE_TOKEN="${GENERATED}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="other"',
      '',
    ].join('\n'));
    const plan = planFor(workspace, { host: '192.168.1.20', port: 8790, deviceId: 'desk' });
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.some((warning) => warning.includes('--host/--port were not applied'))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('differs from --device-id'))).toBe(true);
  });
});

describe('a missing or unusable firmware folder', () => {
  it('warns and writes the Mac config when no firmware folder is given', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, { firmwareDir: null });
    expect(plan.files.some((file) => file.kind === 'firmware')).toBe(false);
    expect(plan.warnings.some((warning) => warning.includes('--firmware-dir'))).toBe(true);
    expect(fileOf(plan, 'mac').action).toBe('create');
  });

  it('reports a firmware folder that does not exist instead of creating one', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, { firmwareDir: join(workspace.root, 'nope') });
    expect(plan.errors.some((error) => error.includes('Firmware folder'))).toBe(true);
  });
});

describe('applying a plan', () => {
  it('writes both files privately', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace);
    const { created } = applySetupPlan(plan);
    expect(created).toEqual([workspace.macFile, workspace.firmwareFile]);
    expect(readFileSync(workspace.macFile, 'utf8')).toContain(GENERATED);
    expect(readFileSync(workspace.firmwareFile, 'utf8')).toContain(GENERATED);
  });

  it('refuses a plan that already found a problem', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, { host: 'ws://192.168.1.20' });
    expect(() => applySetupPlan(plan)).toThrow(/Refusing to write/);
    expect(existsSync(workspace.macFile)).toBe(false);
  });

  it('cleans up a half-written pair when the second write fails', () => {
    const workspace = makeWorkspace();
    mkdirSync(workspace.firmwareFile);
    const plan = planFor(workspace);
    expect(() => applySetupPlan(plan)).toThrow();
    expect(existsSync(workspace.macFile)).toBe(false);
    expect(existsSync(workspace.firmwareFile)).toBe(true);
  });

  it('never removes a file that was already there', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${EXISTING_MAC}\n`);
    mkdirSync(workspace.firmwareFile);
    const plan = planFor(workspace);
    expect(() => applySetupPlan(plan)).toThrow();
    expect(readFileSync(workspace.macFile, 'utf8')).toContain(EXISTING_MAC);
  });
});

describe('the printable preview', () => {
  it('never contains the secret', () => {
    const workspace = makeWorkspace();
    const preview = buildSetupPreview(planFor(workspace));
    expect(JSON.stringify(preview)).not.toContain(GENERATED);
    expect(preview.mac.action).toBe('create');
    expect(preview.firmware?.action).toBe('create');
  });
});

describe('picking the device id from the detected board', () => {
  it('uses "desk" as the default for the 1.85C without a --device-id flag', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-lcd-1.85c'),
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.board).toBe('esp32-s3-touch-lcd-1.85c');
    expect(plan.deviceId).toBe('desk');
    expect(fileOf(plan, 'firmware').content).toContain('CONFIG_VOICEMODE_DEVICE_ID="desk"');
  });

  it('uses "watch" as the default for the AMOLED 2.06 without a --device-id flag', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.board).toBe('esp32-s3-touch-amoled-2.06');
    expect(plan.deviceId).toBe('watch');
    expect(fileOf(plan, 'firmware').content).toContain('CONFIG_VOICEMODE_DEVICE_ID="watch"');
  });

  it('keeps the existing device config byte for byte when the device already names something', () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.firmwareFile, [
      'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
      `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="kitchen-watch"',
      '',
    ].join('\n'));
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    // The board default would have been 'watch', but the device config already
    // names something else and setup will not overwrite it.
    expect(plan.deviceId).toBe('watch');
    expect(fileOf(plan, 'firmware').action).toBe('keep');
    expect(fileOf(plan, 'mac').content).toContain(`DEVICE_SHARED_SECRET=${EXISTING_DEVICE}`);
    expect(plan.warnings.some((warning) => warning.includes('kitchen-watch'))).toBe(true);
  });

  it('still honours --device-id, even when the board default would have been something else', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: 'workbench',
    });
    expect(plan.errors).toEqual([]);
    expect(plan.deviceId).toBe('workbench');
    expect(fileOf(plan, 'firmware').content).toContain('CONFIG_VOICEMODE_DEVICE_ID="workbench"');
  });

  it('warns when the user passed --device-id that does not match the detected board default', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: 'desk',
    });
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.some((warning) => warning.includes('esp32-s3-touch-amoled-2.06'))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('default device id'))).toBe(true);
  });

  it('does not warn when the user passed --device-id that matches the detected board default', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: 'watch',
    });
    expect(plan.warnings.some((warning) => warning.includes('default device id'))).toBe(false);
  });

  it('errors when the firmware folder holds no supported board', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: unsupportedDetection(['esp32-c6-touch-amoled-2.06']),
      deviceId: undefined,
    });
    expect(plan.errors.some((error) => error.includes('no supported board'))).toBe(true);
    expect(plan.errors.some((error) => error.includes('esp32-c6-touch-amoled-2.06'))).toBe(true);
  });

  it('errors when the firmware folder holds both supported boards and refuses to guess', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: ambiguousDetection(
        ['esp32-s3-touch-lcd-1.85c', 'esp32-s3-touch-amoled-2.06'],
        false,
      ),
      deviceId: undefined,
    });
    expect(plan.errors.some((error) => error.includes('more than one supported watch'))).toBe(true);
    expect(plan.errors.some((error) => error.includes('--board'))).toBe(true);
    expect(() => applySetupPlan(plan)).toThrow();
  });

  it('falls back to the historic default when the firmware folder is not given', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      firmwareDir: null,
      detectBoard: detectionForBoard(null),
    });
    expect(plan.board).toBeNull();
    expect(plan.deviceId).toBe('desk');
  });

  it('records the detected board on the printable preview', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    const preview = buildSetupPreview(plan);
    expect(preview.board).toBe('esp32-s3-touch-amoled-2.06');
    expect(preview.deviceId).toBe('watch');
  });

  it('includes the matching build command on the plan and the preview', () => {
    const workspace = makeWorkspace();
    const planAmoled = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(planAmoled.buildCommand).toBe(
      'python3 firmware/scripts/build.py waveshare/esp32-s3-touch-amoled-2.06',
    );
    const previewAmoled = buildSetupPreview(planAmoled);
    expect(previewAmoled.buildCommand).toBe(planAmoled.buildCommand);

    const planLcd = planFor(workspace, {
      detectBoard: detectionForBoard('esp32-s3-touch-lcd-1.85c'),
      deviceId: undefined,
    });
    expect(planLcd.buildCommand).toBe(
      'python3 firmware/scripts/build.py waveshare/esp32-s3-touch-lcd-1.85c',
    );
  });

  it('leaves the build command blank when no board is known', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      firmwareDir: null,
      detectBoard: detectionForBoard(null),
    });
    expect(plan.board).toBeNull();
    expect(plan.buildCommand).toBeNull();
  });
});

describe('the explicit --board option', () => {
  it('wins over a stale sdkconfig that names the other watch', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      detectBoard: detectionForBoard(null), // should be overridden
      board: 'esp32-s3-touch-amoled-2.06',
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.board).toBe('esp32-s3-touch-amoled-2.06');
    expect(plan.deviceId).toBe('watch');
    expect(plan.buildCommand).toBe('python3 firmware/scripts/build.py waveshare/esp32-s3-touch-amoled-2.06');
  });

  it('chooses the right default device id even when no firmware folder is given', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      firmwareDir: null,
      board: 'esp32-s3-touch-amoled-2.06',
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.deviceId).toBe('watch');
  });

  it('refuses an unknown watch id before touching anything', () => {
    const workspace = makeWorkspace();
    const plan = planFor(workspace, {
      board: 'esp32-c6-touch-amoled-2.06',
      deviceId: undefined,
    });
    expect(plan.errors.some((error) => error.includes('Unknown watch id'))).toBe(true);
    expect(plan.errors.some((error) => error.includes('esp32-s3-touch-lcd-1.85c'))).toBe(true);
    expect(plan.errors.some((error) => error.includes('esp32-s3-touch-amoled-2.06'))).toBe(true);
    expect(() => applySetupPlan(plan)).toThrow();
  });

  it('lets the user pick a watch that is not yet in the firmware folder, with a build-command warning', () => {
    const workspace = makeWorkspace();
    // The test firmware folder has no boards directory at all, so the only
    // way to land on the AMOLED 2.06 default is via --board.
    const plan = planFor(workspace, {
      board: 'esp32-s3-touch-amoled-2.06',
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.deviceId).toBe('watch');
    expect(plan.warnings.some((warning) => warning.toLowerCase().includes('build it with'))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('esp32-s3-touch-amoled-2.06'))).toBe(true);
  });
});

describe('the effective device id the plan compares against', () => {
  function writeFile(path: string, content: string): void {
    writeFileSync(path, content);
  }

  function makeWorkspaceWithFiles(
    local: string,
    generated: string | null,
  ): ReturnType<typeof makeWorkspace> {
    const ws = makeWorkspace();
    writeFile(ws.firmwareFile, local);
    if (generated !== null) {
      writeFile(join(ws.root, 'firmware', 'sdkconfig'), generated);
    }
    return ws;
  }

  it('does not warn about a wrong-board device id when the generated sdkconfig already reports the right one', () => {
    // The local file deliberately keeps `desk`. The generated sdkconfig
    // (from a build that applied the AMOLED 2.06 fragment last) reports
    // `watch`. The plan must not warn that the device config still says
    // `desk`, because the build will produce `watch`.
    const ws = makeWorkspaceWithFiles(
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="desk"',
        '',
      ].join('\n'),
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="watch"',
        '',
      ].join('\n'),
    );
    const plan = planFor(ws, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.deviceId).toBe('watch');
    // No "already names a different device" warning against the build
    // output: the effective id is `watch`, matching the plan.
    expect(plan.warnings.some((warning) => warning.includes('differs from --device-id'))).toBe(false);
    expect(plan.warnings.some((warning) => warning.includes('default ("watch") was not applied'))).toBe(false);
  });

  it('mentions the local file when the generated sdkconfig agrees but the local one is stale', () => {
    // The local file still has `desk`, the generated file has `watch`. The
    // effective id matches the plan, so no board-mismatch warning fires,
    // but the user should know the local file is out of sync so they can
    // clean it up if they want.
    const ws = makeWorkspaceWithFiles(
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="desk"',
        '',
      ].join('\n'),
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="watch"',
        '',
      ].join('\n'),
    );
    const plan = planFor(ws, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(plan.warnings.some((warning) => warning.includes('sdkconfig.defaults.local still names "desk"'))).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('generated sdkconfig already reports "watch"'))).toBe(true);
  });

  it('falls back to the local file when there is no generated sdkconfig', () => {
    // Fresh checkout, only the local override is present. The plan should
    // still produce the right warning when the local file disagrees.
    const ws = makeWorkspaceWithFiles(
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="kitchen"',
        '',
      ].join('\n'),
      null,
    );
    const plan = planFor(ws, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(plan.warnings.some((warning) => warning.includes('sdkconfig.defaults.local already names "kitchen"'))).toBe(true);
  });

  it('still warns when the effective value is wrong, naming the source', () => {
    // The generated sdkconfig reports `kitchen`, the plan wants `watch`.
    // That is a real failure: the device will be misconfigured after the
    // next build. The warning should name the source so the user can fix
    // the right file.
    const ws = makeWorkspaceWithFiles(
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="kitchen"',
        '',
      ].join('\n'),
      [
        'CONFIG_VOICEMODE_URL="ws://10.0.0.107:8790"',
        `CONFIG_VOICEMODE_TOKEN="${EXISTING_DEVICE}"`,
        'CONFIG_VOICEMODE_DEVICE_ID="kitchen"',
        '',
      ].join('\n'),
    );
    const plan = planFor(ws, {
      detectBoard: detectionForBoard('esp32-s3-touch-amoled-2.06'),
      deviceId: undefined,
    });
    expect(plan.warnings.some((warning) => warning.includes('generated sdkconfig already names "kitchen"'))).toBe(true);
  });
});
