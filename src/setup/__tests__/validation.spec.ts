import { describe, expect, it } from 'bun:test';

import { validateDeviceHost, validateDeviceId, validateSecretValue } from '../validation';

describe('the device address', () => {
  it('accepts a plain host name or IP, IPv6 bracketed', () => {
    for (const host of ['192.168.1.20', '10.0.0.107', 'mac.local', '[::1]']) {
      const result = validateDeviceHost(host);
      expect(result.ok).toBe(true);
    }
    expect(validateDeviceHost(' 192.168.1.20 ')).toEqual({ ok: true, host: '192.168.1.20' });
  });

  it('accepts a bracketed IPv6 address unchanged', () => {
    expect(validateDeviceHost('[fe80::1]')).toEqual({ ok: true, host: '[fe80::1]' });
    expect(validateDeviceHost('[fe80::1]:8790').ok).toBe(false);
    expect(validateDeviceHost('[:::]').ok).toBe(false);
    expect(validateDeviceHost('[1234]').ok).toBe(false);
  });

  it('rejects a scheme, port, path, query, credentials, or whitespace', () => {
    for (const host of [
      'ws://192.168.1.20',
      '192.168.1.20:8790',
      '192.168.1.20/room',
      '192.168.1.20?x=1',
      'user:pass@192.168.1.20',
      'user@192.168.1.20',
      'a b',
      'host\n"',
      '',
    ]) {
      expect(validateDeviceHost(host).ok).toBe(false);
    }
  });
});

describe('a value that goes into a config line', () => {
  it('refuses quotes, backslashes, and control characters', () => {
    expect(validateSecretValue('normal-secret_123')).toBeNull();
    expect(validateSecretValue('')).not.toBeNull();
    expect(validateSecretValue('has"quote')).not.toBeNull();
    expect(validateSecretValue('has\\backslash')).not.toBeNull();
    expect(validateSecretValue('has\nnewline')).not.toBeNull();
    expect(validateSecretValue('has\u0000null')).not.toBeNull();
  });

  it('keeps the same rules for a device id', () => {
    expect(validateDeviceId('desk')).toBeNull();
    expect(validateDeviceId('')).not.toBeNull();
    expect(validateDeviceId('desk"break')).not.toBeNull();
    expect(validateDeviceId('desk\nCONFIG_X=y')).not.toBeNull();
  });
});
