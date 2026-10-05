import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { 
  buildFirmwareFileContent,
  buildMacEnvFileContent,
  detectFirmwareDir,
  macEnvFilePathFromEnvironment,
  parseFirmwareSettings,
  privateFileModeLabel,
  readMacSecret,
  writePrivateFileExclusive,
  readEffectiveDeviceId,
} from '../files';

const SECRET = 'unit-test-shared-secret-value';

it('finds firmware in this checkout before an old sibling checkout', () => {
  const parent = mkdtempSync(join(tmpdir(), 'vm-layout-'));
  const checkout = join(parent, 'voice');
  const local = join(checkout, 'firmware');
  const oldSibling = join(parent, 'esp32-chatgpt-voice-mode-firmware');
  try {
    mkdirSync(local, { recursive: true });
    mkdirSync(oldSibling);
    expect(detectFirmwareDir(checkout, {})).toBe(local);
    rmSync(local, { recursive: true });
    expect(detectFirmwareDir(checkout, {})).toBe(oldSibling);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

describe('reading the firmware config', () => {
  it('pulls the three settings out of a normal file, quotes and spaces included', () => {
    const settings = parseFirmwareSettings([
      '# a comment',
      'CONFIG_VOICEMODE_URL = "ws://192.168.1.20:8790"',
      'CONFIG_VOICEMODE_TOKEN="abc123"',
      'CONFIG_VOICEMODE_DEVICE_ID=desk',
    ].join('\n'));
    expect(settings.url).toBe('ws://192.168.1.20:8790');
    expect(settings.token).toBe('abc123');
    expect(settings.deviceId).toBe('desk');
  });

  it('treats a commented or absent key as missing, and survives a malformed file', () => {
    const settings = parseFirmwareSettings(
      ['# CONFIG_VOICEMODE_TOKEN is not set', 'not a setting at all', '=broken'].join('\n'),
    );
    expect(settings.token).toBeNull();
    expect(settings.url).toBeNull();
    expect(settings.deviceId).toBeNull();
  });
});

describe('reading the Mac secret', () => {
  it('uses the environment override verbatim when it is set', () => {
    const read = readMacSecret({ VOICEMODE_DEVICE_SECRET: '  spaced  ' }, 'DEVICE_SHARED_SECRET=from-file');
    expect(read).toEqual({ state: 'present', secret: '  spaced  ', source: 'environment' });
  });

  it('treats an explicitly empty override as a failure, not a fall back to the file', () => {
    const read = readMacSecret({ VOICEMODE_DEVICE_SECRET: '' }, 'DEVICE_SHARED_SECRET=from-file');
    expect(read.state).toBe('empty-override');
  });

  it('falls back to the env file and reads through the shared parser', () => {
    const read = readMacSecret({}, 'DEVICE_SHARED_SECRET="from-file"\nVOICEMODE_X=1\n');
    expect(read).toEqual({ state: 'present', secret: 'from-file', source: 'env-file' });
  });

  it('reports missing when neither place has one', () => {
    expect(readMacSecret({}, '# nothing here').state).toBe('missing');
    expect(readMacSecret({}, null).state).toBe('missing');
  });

  it('honours VOICEMODE_ENV_FILE for where the listener reads from', () => {
    expect(macEnvFilePathFromEnvironment({ VOICEMODE_ENV_FILE: '/tmp/other.vars' })).toBe('/tmp/other.vars');
    expect(macEnvFilePathFromEnvironment({}).endsWith('.dev.vars')).toBe(true);
  });
});

describe('the files setup writes', () => {
  it('carries the secret and the device address', () => {
    expect(buildMacEnvFileContent(SECRET)).toContain(`DEVICE_SHARED_SECRET=${SECRET}`);
    const firmware = buildFirmwareFileContent({ secret: SECRET, host: '192.168.1.20', port: 8790, deviceId: 'desk' });
    expect(firmware).toContain('CONFIG_VOICEMODE_URL="ws://192.168.1.20:8790"');
    expect(firmware).toContain(`CONFIG_VOICEMODE_TOKEN="${SECRET}"`);
    expect(firmware).toContain('CONFIG_VOICEMODE_DEVICE_ID="desk"');
  });

  it('creates a private file and refuses to replace one that exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vm-files-'));
    const filePath = join(directory, '.dev.vars');
    writePrivateFileExclusive(filePath, buildMacEnvFileContent(SECRET));
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(privateFileModeLabel(filePath)).toBe('0600');

    expect(() => writePrivateFileExclusive(filePath, 'replacement')).toThrow();
    expect(readFileSync(filePath, 'utf8')).toContain(SECRET);
    expect(readFileSync(filePath, 'utf8')).not.toContain('replacement');
  });

  it('labels a loose-permission file and an absent one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vm-files-'));
    const loose = join(directory, 'loose.vars');
    writeFileSync(loose, 'x', { mode: 0o644 });
    expect(privateFileModeLabel(loose)).toBe('other');
    expect(privateFileModeLabel(join(directory, 'missing.vars'))).toBe('absent');
  });
});

describe('the effective device id the firmware will report', () => {
  function makeFirmware(): { root: string; firmwareDir: string; localFile: string; generatedFile: string } {
    const root = mkdtempSync(join(tmpdir(), 'vm-effective-'));
    const firmwareDir = join(root, 'firmware');
    mkdirSync(firmwareDir);
    return {
      root,
      firmwareDir,
      localFile: join(firmwareDir, 'sdkconfig.defaults.local'),
      generatedFile: join(firmwareDir, 'sdkconfig'),
    };
  }

  function rmSyncRecursive(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  it('prefers the generated sdkconfig when it names a device id', () => {
    const ws = makeFirmware();
    try {
      writeFileSync(ws.localFile, 'CONFIG_VOICEMODE_DEVICE_ID="desk"\n');
      writeFileSync(ws.generatedFile, 'CONFIG_VOICEMODE_DEVICE_ID="watch"\n');
      const result = readEffectiveDeviceId(ws.firmwareDir);
      expect(result).toEqual({ source: 'generated', deviceId: 'watch' });
    } finally {
      rmSyncRecursive(ws.root);
    }
  });

  it('falls back to the local file when the generated sdkconfig has no device id', () => {
    const ws = makeFirmware();
    try {
      writeFileSync(ws.localFile, 'CONFIG_VOICEMODE_DEVICE_ID="desk"\n');
      writeFileSync(ws.generatedFile, '# CONFIG_VOICEMODE_DEVICE_ID is not set\n');
      const result = readEffectiveDeviceId(ws.firmwareDir);
      expect(result).toEqual({ source: 'local', deviceId: 'desk' });
    } finally {
      rmSyncRecursive(ws.root);
    }
  });

  it('falls back to the local file when there is no generated sdkconfig yet', () => {
    const ws = makeFirmware();
    try {
      writeFileSync(ws.localFile, 'CONFIG_VOICEMODE_DEVICE_ID="desk"\n');
      const result = readEffectiveDeviceId(ws.firmwareDir);
      expect(result).toEqual({ source: 'local', deviceId: 'desk' });
    } finally {
      rmSyncRecursive(ws.root);
    }
  });

  it('reports none when neither file has a device id', () => {
    const ws = makeFirmware();
    try {
      const result = readEffectiveDeviceId(ws.firmwareDir);
      expect(result).toEqual({ source: 'none', deviceId: null });
    } finally {
      rmSyncRecursive(ws.root);
    }
  });

  it('lets the build fragment override a deliberately retained local value', () => {
    // This is the real workflow: the user keeps the old `desk` in their
    // local override file, but the AMOLED 2.06 board config applies last
    // and the generated sdkconfig reports `watch`. The effective value
    // the device will report is `watch`, not `desk`.
    const ws = makeFirmware();
    try {
      writeFileSync(ws.localFile, [
        'CONFIG_VOICEMODE_URL="ws://192.168.1.20:8790"',
        'CONFIG_VOICEMODE_TOKEN="some-secret"',
        'CONFIG_VOICEMODE_DEVICE_ID="desk"',
        '',
      ].join('\n'));
      writeFileSync(ws.generatedFile, [
        'CONFIG_VOICEMODE_URL="ws://192.168.1.20:8790"',
        'CONFIG_VOICEMODE_TOKEN="some-secret"',
        'CONFIG_VOICEMODE_DEVICE_ID="watch"',
        '',
      ].join('\n'));
      const result = readEffectiveDeviceId(ws.firmwareDir);
      expect(result).toEqual({ source: 'generated', deviceId: 'watch' });
    } finally {
      rmSyncRecursive(ws.root);
    }
  });
});
