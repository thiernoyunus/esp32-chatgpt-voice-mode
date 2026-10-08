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
  #child: ReturnType<typeof spawn> | null = null;

  // `direct`: the path of the Codex executable to start ourselves. Otherwise
  // connect to the desktop host. (Passed in, not imported: Codex desktop runs
  // this file with its own node, which cannot resolve extensionless imports.)
  constructor(cwd: string, overrides: string[], directory = desktopCoreDirectory(),
    direct?: string) {
    super();
    if (direct !== undefined) {
      // Started by us, as before the desktop host existed (so without the
      // host's own desktop-only MCP server). Never depends on Codex desktop.
      queueMicrotask(() => this.#spawnDirect(direct, cwd, overrides));
      return;
    }
    const candidates = desktopHostSockets(directory);
    const connect = () => {
      const path = candidates.pop();
      if (this.killed) return;
      if (!path) {
        this.stderr.write('Codex desktop host is unavailable: Codex desktop is not running it.\n');
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
        // Send nothing until the host says it has handed over: until then
        // the host could still read it.
        let head = Buffer.alloc(0);
        const awaitReady = (chunk: Buffer) => {
          head = Buffer.concat([head, chunk]);
          const newline = head.indexOf(10);
          if (newline < 0) return;
          socket.off('data', awaitReady);
          if (head.length > newline + 1) this.stdout.write(head.subarray(newline + 1));
          this.stdin.pipe(socket).pipe(this.stdout);
        };
        socket.on('data', awaitReady);
      });
    };
    // Give the caller time to attach its error and exit handlers.
    queueMicrotask(connect);
  }

  #spawnDirect(executable: string, cwd: string, overrides: string[]): void {
    if (this.killed) return;
    const child = spawn(executable, ['app-server', '--listen', 'stdio://', ...overrides,
      '-c', `mcp_servers.${DESKTOP_CORE_HOST_NAME}.enabled=false`],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', (error) => { this.stderr.write(`${error.message}\n`); this.emit('exit', 1); });
    child.on('exit', (code) => { this.stdout.end(); this.emit('exit', this.killed ? 0 : code ?? 1); });
    child.stderr.pipe(this.stderr, { end: false });
    child.stdout.pipe(this.stdout);
    this.stdin.pipe(child.stdin);
    this.#child = child;
  }

  kill(): void { this.killed = true; this.#socket?.destroy(); this.#child?.kill(); this.stdin.destroy(); }
}

/** The desktop host's private sockets, newest last. */
function desktopHostSockets(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory)
    .filter((name) => name.endsWith('.sock')).map((name) => join(directory, name))
    .filter((path) => { try { const stat = lstatSync(path);
      return stat.isSocket() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
    } catch { return false; } }).sort((a, b) => { try { return lstatSync(a).mtimeMs - lstatSync(b).mtimeMs; } catch { return 0; } }) : [];
}

/**
 * Whether a desktop host answers right now. Codex desktop runs it while the
 * app is open and its registered file loads; old sockets outlive it, so a file
 * alone is not enough.
 */
export async function desktopHostAnswers(directory = desktopCoreDirectory(), timeoutMilliseconds = 1_500) {
  for (const path of desktopHostSockets(directory).reverse()) {
    const answered = await new Promise<boolean>((resolve) => {
      const socket = createConnection(path);
      const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
      const timer = setTimeout(() => done(false), timeoutMilliseconds);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (answered) return true;
  }
  return false;
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
        // The client waits for "ready" before sending more.
        if (buffer.length > newline + 1) { socket.destroy(); return; }
        socket.pause();
        /* The call's Codex is given the connection itself, in its own process
         * group: Codex desktop runs a copy of this host per chat and stops it
         * when that chat closes - often mid-call, since a call opens its own
         * chat - and calls borrowed through the host died with it. Needs node:
         * Bun cannot hand a socket to a child. */
        const child = spawn(executable, ['app-server', '--listen', 'stdio://', ...overrides,
          '-c', `mcp_servers.${DESKTOP_CORE_HOST_NAME}.enabled=false`,
          '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'],
        { cwd, stdio: [socket, socket, 'inherit'], detached: true, env: { ...process.env,
          CODEX_MCP_NODE_PATH: process.execPath, CODEX_BROWSER_USE_NODE_PATH: process.execPath } });
        child.on('error', () => socket.destroy());
        child.unref();
        socket.write('ready\n', () => socket.destroy());
      } catch { socket.destroy(); }
    };
    socket.on('data', readStart);
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(path, resolveListen); });
  chmodSync(path, 0o600);
  return { path, close() {
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
  // Quit to the background, Codex desktop deletes this host's door to its app
  // tools but may leave the host running; a call borrowed through it gets
  // project tools that all fail. Stop taking calls once the door is gone, so
  // calls start Codex themselves and say why there are no projects.
  const door = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  setInterval(() => { if (!existsSync(door)) close(); }, 2_000).unref();
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await mcp.connect(new StdioServerTransport());
}
