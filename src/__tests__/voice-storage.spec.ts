import { expect, test } from 'bun:test';
import { voiceStorageRoot, voiceStorageError } from '../voice-storage';

test('fresh installs keep chat storage outside protected Documents and Desktop', () => {
  expect(voiceStorageRoot({}, '/Users/test')).toBe(
    '/Users/test/Library/Application Support/ESP32 Voice Mode/chats',
  );
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
