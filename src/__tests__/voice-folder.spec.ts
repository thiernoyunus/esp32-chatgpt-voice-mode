import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVoiceChatFolder } from '../codex';

test('a chat folder looks like the app makes it: numbered, with work and outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-folder-'));
  const day = new Date(2026, 8, 21);
  try {
    const first = createVoiceChatFolder(root, day);
    expect(first).toBe(join(root, '2026-09-21', 'realtime-voice-chat'));
    expect(readdirSync(first).sort()).toEqual(['outputs', 'work']);

    const second = createVoiceChatFolder(root, day);
    expect(second).toBe(join(root, '2026-09-21', 'realtime-voice-chat-2'));
    expect(readdirSync(second).sort()).toEqual(['outputs', 'work']);

    // A name taken by something that is not a folder must be skipped, not used.
    mkdirSync(join(root, '2026-09-21', 'realtime-voice-chat-3'), { recursive: true });
    expect(createVoiceChatFolder(root, day)).toBe(
      join(root, '2026-09-21', 'realtime-voice-chat-4'),
    );
    expect(existsSync(join(root, '2026-09-21', 'realtime-voice-chat-3', 'work'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
