import { expect, test } from 'bun:test';
import { releaseVoiceChat } from '../voice-release';
import { buildCodexOverrides } from '../codex';

test('hang-up waits for voice stop, then releases without starting another agent turn', async () => {
  const calls: string[] = [];
  let finishStop!: () => void;
  const stop = new Promise<void>((resolve) => { finishStop = resolve; });
  const done = releaseVoiceChat(async (method, params) => {
    expect(params.threadId).toBe('call');
    calls.push(method);
    if (method === 'thread/realtime/stop') await stop;
  }, 'call');
  expect(calls).toEqual(['thread/realtime/stop']);
  finishStop();
  expect(await done).toBe(true);
  expect(calls).toEqual(['thread/realtime/stop', 'thread/unsubscribe']);
  expect(buildCodexOverrides()).toContain('thread_unload_delay_secs=0');
});

test('already-ended voice still releases the chat', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  expect(await releaseVoiceChat(async (method) => {
    calls.push(method);
    if (method === 'thread/realtime/stop') throw new Error('already closed');
  }, 'call', (error) => errors.push(error))).toBe(true);
  expect(calls).toEqual(['thread/realtime/stop', 'thread/unsubscribe']);
  expect(errors).toHaveLength(1);
});

test('failed release is reported instead of claiming success', async () => {
  const errors: string[] = [];
  expect(await releaseVoiceChat(async (method) => {
    if (method === 'thread/unsubscribe') throw new Error('disconnected');
  }, 'call', (error) => errors.push(error))).toBe(false);
  expect(errors[0]).toContain('Could not release voice chat call');
});
