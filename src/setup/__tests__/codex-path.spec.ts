import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeCodexVersion, sanitizeVersionOutput } from '../codex-path';

function makeExecutable(name: string, body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'vm-codex-'));
  const filePath = join(directory, name);
  writeFileSync(filePath, body);
  chmodSync(filePath, 0o755);
  return filePath;
}

describe('reading a version string', () => {
  it('accepts only the exact line Codex prints', () => {
    expect(sanitizeVersionOutput('codex-cli 0.154.0')).toBe('codex-cli 0.154.0');
    expect(sanitizeVersionOutput('\n\ncodex-cli 0.154.0-alpha\nbuilt today')).toBe('codex-cli 0.154.0-alpha');
    expect(sanitizeVersionOutput('codex-cli 0.154.0+build.7')).toBe('codex-cli 0.154.0+build.7');
  });

  it('discards anything else, including text that could carry a secret', () => {
    expect(sanitizeVersionOutput('token=abc123')).toBeNull();
    expect(sanitizeVersionOutput('/Users/someone/.codex/secret')).toBeNull();
    expect(sanitizeVersionOutput('codex 0.154.0')).toBeNull();
    expect(sanitizeVersionOutput('codex-cli 0.154')).toBeNull();
    expect(sanitizeVersionOutput('codex-cli not-a-version')).toBeNull();
    expect(sanitizeVersionOutput('   ')).toBeNull();
    expect(sanitizeVersionOutput(`codex-cli 0.154.0 ${'x'.repeat(200)}`)).toBeNull();
  });
});

describe('running --version', () => {
  it('reports a missing program without launching anything', async () => {
    expect(await probeCodexVersion('/definitely/not/here/codex', 500)).toEqual({
      present: false,
      version: null,
      timedOut: false,
      failed: false,
    });
    expect((await probeCodexVersion('', 500)).present).toBe(false);
  });

  it('reports a version the program actually prints', async () => {
    const script = makeExecutable('fake-codex', '#!/bin/sh\necho "codex-cli 0.154.0-alpha"\n');
    const probe = await probeCodexVersion(script, 2_000);
    expect(probe.present).toBe(true);
    expect(probe.version).toBe('codex-cli 0.154.0-alpha');
    expect(probe.timedOut).toBe(false);
  });

  it('discards an unfamiliar answer even when the program succeeds', async () => {
    const script = makeExecutable('odd-codex', '#!/bin/sh\necho "api-key: sk-very-private"\n');
    const probe = await probeCodexVersion(script, 2_000);
    expect(probe.present).toBe(true);
    expect(probe.version).toBeNull();
  });

  it('gives up on a program that hangs', async () => {
    const script = makeExecutable('slow-codex', '#!/bin/sh\nsleep 10\n');
    const started = Date.now();
    const probe = await probeCodexVersion(script, 200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probe.timedOut).toBe(true);
    expect(probe.version).toBeNull();
  });
});
