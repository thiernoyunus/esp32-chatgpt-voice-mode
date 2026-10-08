import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { DesktopCodexProcess, desktopHostAnswers } from '../desktop-core';

// Codex desktop runs the host with node, and only node can hand a socket to a
// child process, so the host runs in node here too.
async function startHost(executable: string, directory: string) {
  const source = new URL('../desktop-core.ts', import.meta.url).pathname;
  const host = spawn('node', ['--input-type=module', '-e',
    `const { startDesktopCoreHost } = await import(${JSON.stringify(source)});
     const host = await startDesktopCoreHost(process.argv[1], process.argv[2]);
     console.log(host.path); process.stdin.resume().on('end', () => { host.close(); process.exit(0); });`,
    executable, directory], { stdio: ['pipe', 'pipe', 'inherit'] });
  const path = await new Promise<string>((resolve, reject) => {
    host.once('exit', (code) => reject(new Error(`host exited ${code}`)));
    host.stdout.once('data', (data) => resolve(data.toString().trim()));
  });
  host.removeAllListeners('exit');
  const exited = new Promise((resolve) => host.once('exit', resolve));
  return { path, close: async () => { host.stdin.end(); await exited; },
    kill: async () => { host.kill('SIGKILL'); await exited; } };
}

test('desktop owns the core, preserves its messages, and rejects invalid startup data', async () => {
  const directory = mkdtempSync('/tmp/esp-core-check-');
  const executable = join(directory, 'fake-core');
  writeFileSync(executable, '#!/bin/sh\n[ "$1" = app-server ] || exit 1\n[ -x "$CODEX_MCP_NODE_PATH" ] || exit 2\n[ "$CODEX_MCP_NODE_PATH" = "$CODEX_BROWSER_USE_NODE_PATH" ] || exit 3\nexec cat\n');
  chmodSync(executable, 0o700);
  let host = await startHost(executable, directory);
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
    expect(await desktopHostAnswers(directory)).toBe(true);
    await check();
    const invalid = createConnection(host.path);
    const closed = new Promise<void>((resolve) => invalid.once('close', () => resolve()));
    invalid.on('error', () => {});
    invalid.write(JSON.stringify({ cwd: directory, overrides: ['--listen', 'ws://0.0.0.0:1234'] }) + '\n');
    await closed;
    await host.close();
    // A socket file left behind by a host that stopped does not count.
    expect(await desktopHostAnswers(directory)).toBe(false);
    host = await startHost(executable, directory);
    await check();
    chmodSync(host.path, 0o666);
    const missing = new DesktopCodexProcess(directory, [], directory);
    const error = new Promise<string>((resolve) => missing.stderr.once('data', (data) => resolve(data.toString())));
    expect(await error).toContain('unavailable');
    missing.kill();
  } finally { child?.kill(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a call outlives the host that started it', async () => {
  const directory = mkdtempSync('/tmp/esp-core-check-');
  const executable = join(directory, 'fake-core');
  writeFileSync(executable, '#!/bin/sh\nexec cat\n');
  chmodSync(executable, 0o700);
  const host = await startHost(executable, directory);
  const call = new DesktopCodexProcess(directory, [], directory);
  try {
    const lines = createInterface({ input: call.stdout });
    const echo = (text: string) => new Promise<string>((resolve) => {
      lines.once('line', resolve);
      call.stdin.write(`${text}\n`);
    });
    expect(await echo('before')).toBe('before');
    await host.kill();  // as Codex desktop does when the host's chat closes
    expect(await echo('after')).toBe('after');
    lines.close();
  } finally { call.kill(); rmSync(directory, { recursive: true, force: true }); }
});

test('the desktop host file loads under Codex desktop node, which cannot resolve extensionless local imports', () => {
  const source = readFileSync(new URL('../desktop-core.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from '\.\.?\//);
});
