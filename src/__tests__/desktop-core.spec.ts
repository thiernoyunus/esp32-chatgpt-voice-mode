import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DesktopCodexProcess, startDesktopCoreHost } from '../desktop-core';

test('desktop owns the core, preserves its messages, and rejects invalid startup data', async () => {
  const directory = mkdtempSync('/tmp/esp-core-check-');
  const executable = join(directory, 'fake-core');
  writeFileSync(executable, '#!/bin/sh\n[ "$1" = app-server ] || exit 1\nexec cat\n');
  chmodSync(executable, 0o700);
  let host = await startDesktopCoreHost(executable, directory);
  let child: DesktopCodexProcess | undefined;
  const check = async () => {
    child = new DesktopCodexProcess(directory, ['-c', 'model="test"'], directory);
    const lines = createInterface({ input: child.stdout });
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('core did not answer')), 2_000);
      lines.once('line', (line) => { clearTimeout(timer); resolve(line); });
    });
    const message = JSON.stringify({ id: 8, method: 'initialize', params: { capabilities: { experimentalApi: true } } });
    child.stdin.write(`${message}\n`);
    expect(await response).toBe(message);
    child.kill();
    lines.close();
  };
  try {
    await check();
    const invalid = createConnection(host.path);
    const closed = new Promise<void>((resolve) => invalid.once('close', () => resolve()));
    invalid.on('error', () => {});
    invalid.write(JSON.stringify({ cwd: directory, overrides: ['--listen', 'ws://0.0.0.0:1234'] }) + '\n');
    await closed;
    host.close();
    host = await startDesktopCoreHost(executable, directory);
    await check();
    chmodSync(host.path, 0o666);
    const missing = new DesktopCodexProcess(directory, [], directory);
    const error = new Promise<string>((resolve) => missing.stderr.once('data', (data) => resolve(data.toString())));
    expect(await error).toContain('Open Codex');
    missing.kill();
  } finally { child?.kill(); host.close(); rmSync(directory, { recursive: true, force: true }); }
});
