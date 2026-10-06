import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveCodexExecutable } from '../src/codex-executable';

const executable = resolveCodexExecutable().path;
const resources = resolve(dirname(executable), '../../../..');
const node = join(resources, 'cua_node/bin/node');
if (!existsSync(node)) throw new Error('Update Codex on this Mac: its bundled desktop runtime is missing.');
const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
const request = async (id: number, method: string, params: unknown) => {
  const result = new Promise<void>((resolveRequest, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Codex did not answer ${method}.`)), 10_000);
    const read = (line: string) => {
      const message = JSON.parse(line);
      if (message.id !== id) return;
      clearTimeout(timeout); lines.off('line', read);
      message.error ? reject(new Error(message.error.message)) : resolveRequest();
    };
    lines.on('line', read);
    child.once('error', reject);
  });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return result;
};
try {
  await request(1, 'initialize', { clientInfo: { name: 'esp_codex_setup', version: '1.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  await request(2, 'config/value/write', {
    keyPath: 'mcp_servers.esp_codex_host', mergeStrategy: 'replace',
    value: { command: node, args: [resolve(import.meta.dir, '../src/desktop-core.ts'), executable],
      env_vars: ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_HOME', 'HOME'],
      env: { CODEX_MCP_NODE_PATH: node, CODEX_BROWSER_USE_NODE_PATH: node }, startup_timeout_sec: 10 },
  });
  console.log('Registered the ESP companion in Codex desktop.');
} finally { lines.close(); child.kill(); }
