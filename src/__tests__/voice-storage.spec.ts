import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceStorageRoot, voiceStorageError } from '../voice-storage';

test('fresh installs put voice chats beside regular Codex chats', () => {
  expect(voiceStorageRoot({}, '/Users/test')).toBe(
    '/Users/test/Documents/Codex',
  );
});

test('new chats follow the Codex projectless task folder when it is customized', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'voice-storage-'));
  try {
    writeFileSync(join(codexHome, 'config.toml'),
      '[desktop]\nprojectlessWorkspaceRoot = "/other/codex-chats"\n');
    expect(voiceStorageRoot({ CODEX_HOME: codexHome }, '/Users/test')).toBe('/other/codex-chats');
    expect(voiceStorageRoot({ CODEX_HOME: codexHome, VOICEMODE_CODEX_ROOT: '/watch-only' },
      '/Users/test')).toBe('/watch-only');
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('explicit folders stay explicit and ROOT takes precedence over legacy CWD', () => {
  expect(voiceStorageRoot({ VOICEMODE_CODEX_ROOT: ' /custom/chats ',
    VOICEMODE_CODEX_CWD: '/legacy' })).toBe('/custom/chats');
  expect(voiceStorageRoot({ VOICEMODE_CODEX_ROOT: ' ',
    VOICEMODE_CODEX_CWD: '/legacy' })).toBe('/legacy');
  expect(() => voiceStorageRoot({ VOICEMODE_CODEX_ROOT: 'relative' })).toThrow('absolute');
});

test('permission failures explain the blocked folder without silently relocating chats', () => {
  const error = voiceStorageError('/Users/test/Documents/chats', new Error('Operation not permitted'));
  expect(error.message).toContain('/Users/test/Documents/chats');
  expect(error.message).toContain('Operation not permitted');
  expect(error.message).toContain('Privacy & Security');
  expect(error.message).toContain('Existing chats have not been moved');
});
