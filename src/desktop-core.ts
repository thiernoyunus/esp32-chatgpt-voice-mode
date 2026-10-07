import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const DESKTOP_CORE_HOST_NAME = 'esp_codex_host';
export function desktopCoreDirectory() {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'ipc', 'esp-core-host');
}

const startSchema = z.object({
  cwd: z.string().min(1).max(4096).refine(isAbsolute),
  overrides: z.array(z.string().max(8192)).max(256).refine((args) =>
    args.length % 2 === 0 && args.every((arg, index) => index % 2 !== 0 || arg === '-c')),
}).strict();

/** Same wire messages as a child process, but Codex desktop owns that child. */
export class DesktopCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  #socket: Socket | null = null;

  constructor(cwd: string, overrides: string[], directory = desktopCoreDirectory()) {
    super();
    const candidates = existsSync(directory) ? readdirSync(directory)
      .filter((name) => name.endsWith('.sock')).map((name) => join(directory, name))
      .filter((path) => { try { const stat = lstatSync(path);
        return stat.isSocket() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
      } catch { return false; } }).sort((a, b) => { try { return lstatSync(a).mtimeMs - lstatSync(b).mtimeMs; } catch { return 0; } }) : [];
    const connect = () => {
      const path = candidates.pop();
      if (this.killed) return;
      if (!path) {
        this.stderr.write('Codex desktop host is unavailable. Open Codex on this Mac and start or resume a chat.\n');
        this.emit('exit', 1);
        return;
      }
      const socket = createConnection(path);
      this.#socket = socket;
      const failed = () => { socket.destroy(); connect(); };
      socket.once('error', failed);
      socket.once('connect', () => {
        socket.off('error', failed);
        socket.on('error', (error) => { this.stderr.write(`${error.message}\n`); socket.destroy(); });
        socket.on('close', () => { this.stdout.end(); this.emit('exit', this.killed ? 0 : 1); });
        socket.write(`${JSON.stringify(startSchema.parse({ cwd, overrides }))}\n`);
        this.stdin.pipe(socket).pipe(this.stdout);
      });
    };
    // Give the caller time to attach its error and exit handlers.
    queueMicrotask(connect);
  }

  kill(): void { this.killed = true; this.#socket?.destroy(); this.stdin.destroy(); }
}

/** Loaded by Codex desktop as an MCP server, so its children inherit app access. */
export async function startDesktopCoreHost(executable: string, directory = desktopCoreDirectory()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('The Codex desktop host folder must be private to this Mac user.');
  }
  const path = join(directory, `${randomUUID()}.sock`);
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => socket.destroy(), 5_000);
    socket.on('close', () => clearTimeout(timeout));
    const readStart = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      socket.off('data', readStart);
      clearTimeout(timeout);
      try {
        const { cwd, overrides } = startSchema.parse(JSON.parse(buffer.subarray(0, newline).toString()));
        const child = spawn(executable, ['app-server', '--listen', 'stdio://', ...overrides,
          '-c', `mcp_servers.${DESKTOP_CORE_HOST_NAME}.enabled=false`,
          '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'],
        { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
          CODEX_MCP_NODE_PATH: process.execPath, CODEX_BROWSER_USE_NODE_PATH: process.execPath } });
        child.on('error', () => socket.destroy());
        child.stdin.on('error', () => socket.destroy());
        child.stdout.on('error', () => socket.destroy());
        child.on('exit', () => socket.end());
        child.stderr.on('data', (data) => process.stderr.write(data));
        child.stdout.pipe(socket);
        socket.pipe(child.stdin);
        if (buffer.length > newline + 1) child.stdin.write(buffer.subarray(newline + 1));
        socket.on('close', () => child.kill());
      } catch { socket.destroy(); }
    };
    socket.on('data', readStart);
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(path, resolveListen); });
  chmodSync(path, 0o600);
  let closed = false;
  return { path, close() {
    if (closed) return;
    closed = true;
    for (const socket of clients) socket.destroy();
    server.close();
    rmSync(path, { force: true });
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) {
    throw new Error('The ESP Codex host must be started by Codex desktop.');
  }
  const executable = process.argv[2];
  if (!executable || !isAbsolute(executable)) throw new Error('Missing bundled Codex executable.');
  const host = await startDesktopCoreHost(executable);
  const mcp = new Server({ name: DESKTOP_CORE_HOST_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const close = () => { host.close(); void mcp.close(); };
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await mcp.connect(new StdioServerTransport());
}
