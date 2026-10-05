import { expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeviceToken } from '../listener';

it('accepts an explicit device secret without requiring a settings file', async () => {
  expect(await readDeviceToken({ VOICEMODE_DEVICE_SECRET: 'sample', VOICEMODE_ENV_FILE: '/missing/settings' })).toBe('sample');
});

it('reads custom settings and makes missing settings actionable without revealing secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-config-test-'));
  try {
    const path = join(directory, 'settings');
    await expect(readDeviceToken({ VOICEMODE_ENV_FILE: path })).rejects.toThrow('Run bun run setup');
    await writeFile(path, 'DEVICE_SHARED_SECRET="sample+token="\n');
    expect(await readDeviceToken({ VOICEMODE_ENV_FILE: path })).toBe('sample+token=');
    expect(await readDeviceToken({ VOICEMODE_ENV_FILE: path, VOICEMODE_DEVICE_SECRET: 'override' })).toBe('override');
    await expect(readDeviceToken({ VOICEMODE_ENV_FILE: path, VOICEMODE_DEVICE_SECRET: '' })).rejects.toThrow('Run bun run setup');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
