import { describe, expect, it } from 'bun:test';

import { readRealtimeActivity } from '../activity';

const started = (item: object) => readRealtimeActivity('item/started', { threadId: 't', item })?.caption;

describe('readRealtimeActivity', () => {
  it('names what a catch-all js tool is doing instead of showing "Js"', () => {
    expect(started({ type: 'mcpToolCall', server: 'cua_repl', tool: 'js' })).toBe('Using the computer');
    expect(started({ type: 'mcpToolCall', server: 'node_repl', tool: 'js' })).toBe('Using the browser');
  });

  it('still humanizes ordinary tool names', () => {
    expect(started({ type: 'mcpToolCall', server: 'codex_apps', tool: 'gmail.search_emails' })).toBe('Searching emails');
    expect(started({ type: 'commandExecution' })).toBe('Running a command');
  });
});
