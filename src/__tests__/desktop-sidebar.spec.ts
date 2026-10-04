import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DesktopConversationBridge, desktopConversationDates, desktopVoiceTurns, desktopRuntimeStatus } from '../codex';

test('saved speech becomes visible chat messages without starting an agent turn', () => {
  const entries = [
    { item: { id: 'start', type: 'realtimeSessionStarted' } },
    { item: { id: 'greeting', type: 'transcriptSegment', role: 'assistant', text: 'Hello.' } },
    { item: { id: 'question', type: 'transcriptSegment', role: 'user', text: 'Date check' } },
    { item: { id: 'reply', type: 'transcriptSegment', role: 'assistant', text: 'I heard you.' } },
    { item: { id: 'empty', type: 'transcriptSegment', role: 'user', text: ' ' } },
    { item: { id: 'invalid', type: 'transcriptSegment', role: 'system', text: 'Hidden' } },
  ];
  const turns = desktopVoiceTurns(entries, { threadId: 'saved-chat' });
  expect(turns).toHaveLength(3);
  expect(turns.map((turn) => ({ params: turn.params, items: turn.items }))).toEqual([
    { params: { threadId: 'saved-chat', input: [] }, items: [{ id: 'greeting', type: 'agentMessage', text: 'Hello.', phase: 'final' }] },
    {
      params: { threadId: 'saved-chat', input: [{ type: 'text', text: 'Date check', text_elements: [] }] },
      items: [{
        id: 'question', type: 'userMessage', clientId: null,
        content: [{ type: 'text', text: 'Date check', text_elements: [] }],
      }],
    },
    { params: { threadId: 'saved-chat', input: [] }, items: [{ id: 'reply', type: 'agentMessage', text: 'I heard you.', phase: 'final' }] },
  ]);
  expect(turns.every((turn) => turn.turnId === null && turn.status === 'completed')).toBe(true);
});

test('speech still being spoken shows up before the timeline has it', () => {
  const saved = [{ item: { id: 'greeting', type: 'transcriptSegment', role: 'assistant', text: 'Hello.' } }];
  const turns = desktopVoiceTurns(saved, { threadId: 'live-chat' }, [
    { id: 'live-user', type: 'transcriptSegment', role: 'user', text: 'Still talking' },
    { id: 'live-assistant', type: 'transcriptSegment', role: 'assistant', text: 'Listening' },
    { id: 'live-blank', type: 'transcriptSegment', role: 'user', text: '  ' },
    { id: 'live-user', type: 'transcriptSegment', role: 'assistant', text: 'Hello.' },
  ]);
  expect(turns.map((turn) => turn.items)).toEqual([
    [{ id: 'greeting', type: 'agentMessage', text: 'Hello.', phase: 'final' }],
    [{
      id: 'live-user', type: 'userMessage', clientId: null,
      content: [{ type: 'text', text: 'Still talking', text_elements: [] }],
    }],
    [{ id: 'live-assistant', type: 'agentMessage', text: 'Listening', phase: 'final' }],
  ]);
});

test('opening a voice chat preserves its date and recent position', () => {
  const seconds = 1_789_943_270;
  expect(desktopConversationDates({
    createdAt: seconds, updatedAt: seconds + 30, recencyAt: seconds + 10,
  })).toEqual({
    createdAt: seconds * 1_000,
    updatedAt: (seconds + 30) * 1_000,
    recencyAt: (seconds + 10) * 1_000,
  });
  expect(desktopConversationDates({ createdAt: seconds }, 0)).toEqual({
    createdAt: seconds * 1_000, updatedAt: seconds * 1_000, recencyAt: seconds * 1_000,
  });
  expect(desktopConversationDates({ createdAt: NaN, updatedAt: Infinity, recencyAt: null }, 42))
    .toEqual({ createdAt: 42, updatedAt: 42, recencyAt: 42 });
});

test('only explicitly saved chats send a targeted desktop refresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desk-sidebar-'));
  const socketPath = join(directory, 'ipc.sock');
  const messages: Record<string, any>[] = [];
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) break;
        const message = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        messages.push(message);
        if (message.method === 'initialize') {
          const body = Buffer.from(JSON.stringify({
            type: 'response', requestId: message.requestId,
            resultType: 'success', result: { clientId: 'test-desktop-client' },
          }));
          const frame = Buffer.alloc(body.length + 4);
          frame.writeUInt32LE(body.length);
          body.copy(frame, 4);
          socket.write(frame);
        }
      }
    });
  });
  const bridge = new DesktopConversationBridge(socketPath);
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(5);
    expect(condition()).toBe(true);
  };
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    bridge.start();
    await waitFor(() => messages.filter((message) => message.method === 'query-cache-invalidate').length === 3);
    messages.length = 0;
    bridge.registerThread('saved-chat', async () => ({}));
    bridge.registerThread('temporary-chat', async () => ({}));
    bridge.invalidate('unknown-chat');
    await waitFor(() => messages.filter((message) => message.method === 'query-cache-invalidate').length === 9);
    expect(messages.some((message) => message.method === 'thread-unarchived')).toBe(false);

    bridge.invalidate('saved-chat');
    await waitFor(() => messages.some((message) => message.method === 'thread-unarchived'));
    expect(messages.filter((message) => message.method === 'thread-unarchived')).toEqual([{
      type: 'broadcast', method: 'thread-unarchived', version: 1,
      sourceClientId: 'test-desktop-client',
      params: { hostId: 'local', conversationId: 'saved-chat' },
    }]);

    const send = (message: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify(message));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length); body.copy(frame, 4);
      peer!.write(frame);
    };
    let status = { type: 'active' };
    let delayed: (() => void) | undefined;
    let delayNext = false;
    bridge.registerThread('saved-chat', async () => {
      const captured = status;
      if (delayNext) {
        delayNext = false;
        await new Promise<void>((resolve) => { delayed = resolve; });
      }
      return { threadRuntimeStatus: captured, turns: ['saved speech'] };
    });
    send({ type: 'broadcast', method: 'thread-stream-following-changed',
      sourceClientId: 'desktop', params: { conversationId: 'saved-chat', following: true } });
    const snapshots = () => messages.filter((m) => m.method === 'thread-stream-state-changed');
    await waitFor(() => snapshots().length === 1);
    expect(snapshots()[0].params.change.conversationState.threadRuntimeStatus.type).toBe('active');
    delayNext = true;
    bridge.publish('saved-chat');
    await waitFor(() => delayed !== undefined);
    status = { type: 'idle' };
    await bridge.publishAndWait('saved-chat');
    await waitFor(() => snapshots().length === 2);
    delayed!();
    await Bun.sleep(20);
    expect(snapshots()).toHaveLength(2);
    expect(snapshots()[1].params.change.conversationState).toEqual({
      threadRuntimeStatus: { type: 'idle' }, turns: ['saved speech'],
    });
  } finally {
    bridge.close();
    peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ended voice becomes idle without hiding real ongoing work or errors', () => {
  expect(desktopRuntimeStatus(false, { type: 'notLoaded' })).toEqual({ type: 'idle' });
  expect(desktopRuntimeStatus(false, { type: 'idle' })).toEqual({ type: 'idle' });
  expect(desktopRuntimeStatus(true, { type: 'idle' })).toEqual({ type: 'active', activeFlags: [] });
  expect(desktopRuntimeStatus(false, { type: 'active', activeFlags: ['waitingOnApproval'] }))
    .toEqual({ type: 'active', activeFlags: ['waitingOnApproval'] });
  expect(desktopRuntimeStatus(false, { type: 'systemError' })).toEqual({ type: 'systemError' });
});
