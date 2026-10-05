import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor, renderDoctorText, type DoctorReport } from '../doctor';
import { doctorMain } from '../doctor-cli';
import { readListenerHealthFacts } from '../health-probe';
import type { CodexVersionProbe } from '../codex-path';

const SECRET = 'doctor-shared-secret-value';
const ADDRESS = 'ws://192.168.1.20:8790';

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'vm-doctor-'));
  const firmwareDir = join(root, 'firmware');
  mkdirSync(firmwareDir);
  return {
    root,
    firmwareDir,
    macFile: join(root, '.dev.vars'),
    firmwareFile: join(firmwareDir, 'sdkconfig.defaults.local'),
  };
}

function writeMatchingPair(workspace: ReturnType<typeof makeWorkspace>): void {
  writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
  writeFileSync(
    workspace.firmwareFile,
    [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="desk"',
      '',
    ].join('\n'),
  );
}

function healthResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const READY_BODY = {
  service: 'esp32-voice-mode',
  schemaVersion: 1,
  companion: { status: 'ready' },
  device: { connected: true },
  calls: { active: 0 },
  lastError: null,
};

type Route = () => Response | Promise<Response>;

function fetchWithRoutes(routes: Map<string, Route>, onCall?: (url: string) => void): typeof fetch {
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    onCall?.(url);
    const route = routes.get(url);
    if (route === undefined) {
      throw new Error(`no route for ${url}`);
    }
    void init;
    return await route();
  };
  return handler as unknown as typeof fetch;
}

const OK_VERSION: CodexVersionProbe = { present: true, version: 'codex-cli 0.160.0', timedOut: false, failed: false };

function optionsFor(
  workspace: ReturnType<typeof makeWorkspace>,
  overrides: Partial<Parameters<typeof runDoctor>[0]> = {},
) {
  return {
    environment: {} as NodeJS.ProcessEnv,
    macEnvFilePath: workspace.macFile,
    firmwareDir: workspace.firmwareDir,
    host: '127.0.0.1',
    port: 8790,
    probeVersion: async () => OK_VERSION,
    ...overrides,
  };
}

function assertClean(report: DoctorReport, workspace: ReturnType<typeof makeWorkspace>): void {
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(workspace.root);
  expect(serialized).not.toContain('.dev.vars');
  expect(serialized).not.toContain('sdkconfig');
  expect(Object.keys(report).sort()).toEqual(
    ['codex', 'config', 'firmware', 'generatedAt', 'listener', 'ok', 'schemaVersion', 'service', 'warnings'],
  );
}

describe('a healthy setup', () => {
  it('reports ready without leaking the secret, a path, or environment text', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.ok).toBe(true);
    expect(report.config.secretPresent).toBe(true);
    expect(report.config.secretSource).toBe('env-file');
    expect(report.config.secretFileMode).toBe('0600');
    expect(report.firmware.secretMatches).toBe(true);
    expect(report.listener.companionStatus).toBe('ready');
    expect(report.listener.deviceConnected).toBe(true);
    expect(report.listener.activeCalls).toBe(0);
    expect(report.warnings).toEqual([]);
    expect(report.codex.version).toBe('codex-cli 0.160.0');
    assertClean(report, workspace);
  });
});

describe('the readiness report must be trusted carefully', () => {
  it('does not call a starting companion ready, and says so', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const starting = { ...READY_BODY, companion: { status: 'starting' }, device: { connected: false } };
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(starting, 503)]])),
    }));
    expect(report.ok).toBe(false);
    expect(report.listener.status).toBe(503);
    expect(report.listener.companionStatus).toBe('starting');
    expect(report.warnings.some((warning) => warning.includes('not finished starting'))).toBe(true);
  });

  it('refuses a 503 that claims to be ready', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 503)]])),
    }));
    expect(report.ok).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('rather than a ready report'))).toBe(true);
  });

  it('refuses a 200 from a different service or schema', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const wrongService = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([[
        'http://127.0.0.1:8790/health',
        () => healthResponse({ ...READY_BODY, service: 'something-else' }, 200),
      ]])),
    }));
    expect(wrongService.ok).toBe(false);
    expect(wrongService.listener.companionStatus).toBeNull();

    const wrongSchema = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([[
        'http://127.0.0.1:8790/health',
        () => healthResponse({ ...READY_BODY, schemaVersion: 2 }, 200),
      ]])),
    }));
    expect(wrongSchema.ok).toBe(false);
    expect(wrongSchema.warnings.some((warning) => warning.includes('not a usable'))).toBe(true);
  });

  it('gives up when the body stalls or is oversized', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const neverEnds = new ReadableStream<Uint8Array>({ start() {} });
    const StallingResponse = Response as unknown as new (body: unknown, init?: ResponseInit) => Response;
    const stalled = await runDoctor(optionsFor(workspace, {
      listenerTimeoutMilliseconds: 50,
      fetchImpl: fetchWithRoutes(new Map([[
        'http://127.0.0.1:8790/health',
        () => new StallingResponse(neverEnds, { status: 200 }),
      ]])),
    }));
    expect(stalled.listener.timedOut).toBe(true);
    expect(stalled.ok).toBe(false);

    const huge = JSON.stringify({ ...READY_BODY, padding: 'x'.repeat(20_000) });
    const oversized = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => new Response(huge, { status: 200 })]])),
    }));
    expect(oversized.listener.status).toBe(200);
    expect(oversized.listener.companionStatus).toBeNull();
    expect(oversized.ok).toBe(false);
  });
});

describe('failure text is rebuilt, never copied', () => {
  it('maps known codes to safe wording and unknown codes to the generic one', () => {
    const known = readListenerHealthFacts({
      service: 'esp32-voice-mode',
      schemaVersion: 1,
      companion: { status: 'ready' },
      device: { connected: false },
      calls: { active: 0 },
      lastError: { code: 'codex_missing', message: '/Users/private token=abc transcript=hello' },
    });
    expect(known?.lastError?.code).toBe('codex_missing');
    expect(JSON.stringify(known)).not.toContain('/Users/private');
    expect(JSON.stringify(known)).not.toContain('token=abc');

    const unknown = readListenerHealthFacts({
      service: 'esp32-voice-mode',
      schemaVersion: 1,
      companion: { status: 'ready' },
      device: { connected: false },
      calls: { active: 0 },
      lastError: { code: 'something_new', message: 'secret stuff' },
    });
    expect(unknown?.lastError?.code).toBe('voice_failed');
    expect(JSON.stringify(unknown)).not.toContain('secret stuff');
  });
});

describe('an older listener', () => {
  it('warns on a 404 health check and only claims a process exists', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const routes = new Map<string, Route>([
      ['http://127.0.0.1:8790/health', () => new Response('Not found', { status: 404 })],
      ['http://127.0.0.1:8790/', () => new Response('esp32 voice mode listener\n', { status: 200 })],
    ]);
    const report = await runDoctor(optionsFor(workspace, { fetchImpl: fetchWithRoutes(routes) }));
    expect(report.ok).toBe(false);
    expect(report.listener.oldListener).toBe(true);
    expect(report.listener.processPresent).toBe(true);
    expect(report.listener.companionStatus).toBeNull();
    expect(report.warnings.some((warning) => warning.includes('older listener'))).toBe(true);
    assertClean(report, workspace);
  });
});

describe('when nothing answers', () => {
  it('reports not running when neither /health nor / replies', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, { fetchImpl: fetchWithRoutes(new Map()) }));
    expect(report.listener.reachable).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('No listener answered'))).toBe(true);
  });

  it('gives up on a listener that never answers', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const hanging = (async (_input: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: hanging,
      listenerTimeoutMilliseconds: 50,
    }));
    expect(report.listener.timedOut).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('did not answer in time'))).toBe(true);
  });
});

describe('local-only safety', () => {
  it('sends nothing when the requested host is not this Mac', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const calls: string[] = [];
    const report = await runDoctor(optionsFor(workspace, {
      host: '192.168.1.20',
      fetchImpl: fetchWithRoutes(new Map(), (url) => calls.push(url)),
    }));
    expect(calls).toEqual([]);
    expect(report.listener.checked).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('local-only'))).toBe(true);
  });
});

describe('the device config', () => {
  it('fails an incomplete device config that it did check', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
    writeFileSync(workspace.firmwareFile, `CONFIG_VOICEMODE_URL="${ADDRESS}"\n`);
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.checked).toBe(true);
    expect(report.firmware.secretPresent).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('no CONFIG_VOICEMODE_TOKEN'))).toBe(true);
  });

  it('warns safely when the device config cannot be read', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    chmodSync(workspace.firmwareFile, 0o000);
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.ok).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('could not be read'))).toBe(true);
    assertClean(report, workspace);
  });

  it('flags a device secret that does not match, without printing either one', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\\n`);
    writeFileSync(workspace.firmwareFile, `CONFIG_VOICEMODE_URL="${ADDRESS}"\nCONFIG_VOICEMODE_TOKEN="different-device-value"\n`);
    const report = await runDoctor(optionsFor(workspace, {
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.secretMatches).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('different secrets'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('Run bun run setup'))).toBe(false);
    assertClean(report, workspace);
  });
});

describe('problems on the Mac', () => {
  it('flags an empty VOICEMODE_DEVICE_SECRET', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      environment: { VOICEMODE_DEVICE_SECRET: '' },
      fetchImpl: fetchWithRoutes(new Map()),
    }));
    expect(report.config.secretPresent).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('VOICEMODE_DEVICE_SECRET is empty'))).toBe(true);
  });

  it('accepts a secret supplied only by the environment without demanding a file', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.firmwareFile, `CONFIG_VOICEMODE_URL="${ADDRESS}"\nCONFIG_VOICEMODE_TOKEN="${SECRET}"\n`);
    const report = await runDoctor(optionsFor(workspace, {
      environment: { VOICEMODE_DEVICE_SECRET: SECRET },
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.config.secretPresent).toBe(true);
    expect(report.config.secretSource).toBe('environment');
    expect(report.ok).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('No Mac config file'))).toBe(false);
  });

  it('warns when Codex is missing and never claims a model or sign-in state', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      probeVersion: async () => ({ present: false, version: null, timedOut: false, failed: false }),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.codex.executablePresent).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('Codex was not found'))).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('model');
    expect(serialized).not.toContain('sign');
  });
});

describe('choosing Codex', () => {
  it('treats an empty VOICEMODE_CODEX_BIN as broken, the way the runtime does', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const probed: string[] = [];
    const report = await runDoctor(optionsFor(workspace, {
      environment: { VOICEMODE_CODEX_BIN: '' },
      probeVersion: async (executablePath: string) => {
        probed.push(executablePath);
        return { present: executablePath.length > 0, version: null, timedOut: false, failed: false };
      },
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(probed).toEqual(['']);
    expect(report.codex.executableSource).toBe('override');
    expect(report.codex.executablePresent).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('VOICEMODE_CODEX_BIN is set to an empty value'))).toBe(true);
  });

  it('follows the runtime PATH fallback when the bundled copy is gone', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const probed: string[] = [];
    const report = await runDoctor(optionsFor(workspace, {
      codexFileExists: () => false,
      whichCodex: () => '/usr/local/bin/codex',
      probeVersion: async (executablePath: string) => {
        probed.push(executablePath);
        return OK_VERSION;
      },
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(probed).toEqual(['/usr/local/bin/codex']);
    expect(report.codex.executableSource).toBe('path');
    expect(report.ok).toBe(true);
  });

  it('says so when the version answer is not the shape it expects', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      probeVersion: async () => ({ present: true, version: null, timedOut: false, failed: false }),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.warnings.some((warning) => warning.includes('did not recognise'))).toBe(true);
  });
});

describe('the doctor command line', () => {
  function commandDeps(workspace: ReturnType<typeof makeWorkspace>, out: string[], err: string[]) {
    return {
      environment: { VOICEMODE_ENV_FILE: workspace.macFile } as NodeJS.ProcessEnv,
      workingDirectory: workspace.root,
      probeVersion: async () => OK_VERSION,
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    };
  }

  it('prints parseable JSON and exits zero when everything is fine', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const out: string[] = [];
    const err: string[] = [];
    const code = await doctorMain(['--json', '--firmware-dir', workspace.firmwareDir], commandDeps(workspace, out, err));
    expect(code).toBe(0);
    expect(JSON.parse(out.join('')).ok).toBe(true);
    expect(out.join('')).not.toContain(SECRET);
  });

  it('writes a report file once and never overwrites it', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const reportPath = join(workspace.root, 'report.json');
    const out: string[] = [];
    const err: string[] = [];
    const deps = commandDeps(workspace, out, err);
    expect(await doctorMain(['--json', '--report', reportPath, '--firmware-dir', workspace.firmwareDir], deps)).toBe(0);
    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    const written = readFileSync(reportPath, 'utf8');
    expect(JSON.parse(written).ok).toBe(true);

    const err2: string[] = [];
    const code = await doctorMain(['--json', '--report', reportPath, '--firmware-dir', workspace.firmwareDir], {
      ...deps,
      stderr: (text: string) => err2.push(text),
    });
    expect(code).toBe(1);
    expect(err2.join('')).toContain('Refusing to overwrite');
    expect(readFileSync(reportPath, 'utf8')).toBe(written);
  });

  it('rejects a port that only half-parses, and an unknown option', async () => {
    const workspace = makeWorkspace();
    const out: string[] = [];
    const err: string[] = [];
    expect(await doctorMain(['--port', '8790abc'], commandDeps(workspace, out, err))).toBe(2);
    expect(await doctorMain(['--nope'], commandDeps(workspace, out, err))).toBe(2);
    expect(err.join('')).toContain('Unknown option');
  });
});

describe('the doctor recognises the watch the firmware folder was built for', () => {
  function boardFixture(board: string | null) {
    return (_firmwareDir: string | null) => (board === null
      ? { state: 'none' as const }
      : { state: 'one' as const, board, source: 'boards-dir' as const });
  }

  it('reports the detected board in the firmware section of the JSON report', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-lcd-1.85c'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.detectedBoard).toBe('esp32-s3-touch-lcd-1.85c');
    expect(report.firmware.deviceIdMatchesBoard).toBe(true);
  });

  it('flags a device id that disagrees with the detected board default', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\\n`);
    writeFileSync(workspace.firmwareFile, [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="kitchen-watch"',
      '',
    ].join('\n'),
  );
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-amoled-2.06'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.detectedBoard).toBe('esp32-s3-touch-amoled-2.06');
    expect(report.firmware.deviceIdMatchesBoard).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('different watch'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('kitchen-watch'))).toBe(true);
  });

  it('warns when the firmware folder has no supported board', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: () => ({ state: 'unsupported' as const, found: ['esp32-c6-touch-amoled-2.06'] }),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.detectedBoard).toBeNull();
    expect(report.warnings.some((warning) => warning.includes('no supported watch'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('esp32-c6-touch-amoled-2.06'))).toBe(true);
  });

  it('still works when no firmware folder was given, the way the existing doctor did', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
    const report = await runDoctor(optionsFor(workspace, {
      firmwareDir: null,
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.detectedBoard).toBeNull();
    expect(report.firmware.deviceIdMatchesBoard).toBeNull();
    expect(report.warnings.some((warning) => warning.includes('No firmware folder found'))).toBe(true);
  });

  it('surfaces the detected watch in the printable text report', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-lcd-1.85c'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    const text = renderDoctorText(report);
    expect(text).toContain('esp32-s3-touch-lcd-1.85c');
  });

  it('prints the matching build command in the text report', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-amoled-2.06'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    const text = renderDoctorText(report);
    expect(text).toContain('python3 firmware/scripts/build.py waveshare/esp32-s3-touch-amoled-2.06');
  });

  it('omits the build command line when no board is known', async () => {
    const workspace = makeWorkspace();
    writeMatchingPair(workspace);
    const report = await runDoctor(optionsFor(workspace, {
      firmwareDir: null,
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    const text = renderDoctorText(report);
    expect(text).not.toContain('firmware build:');
  });

  it('trusts the generated sdkconfig over a deliberately retained local value', async () => {
    // The user keeps an old `desk` in sdkconfig.defaults.local for a board
    // whose build fragment overrides it. The doctor must not warn that the
    // stored `desk` mismatches the AMOLED 2.06 default, because the
    // generated sdkconfig already carries the correct `watch`.
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
    writeFileSync(workspace.firmwareFile, [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="desk"',
      '',
    ].join('\n'));
    writeFileSync(join(workspace.firmwareDir, 'sdkconfig'), [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="watch"',
      '',
    ].join('\n'));
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-amoled-2.06'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.detectedBoard).toBe('esp32-s3-touch-amoled-2.06');
    expect(report.firmware.effectiveDeviceId).toBe('watch');
    expect(report.firmware.effectiveDeviceIdSource).toBe('generated');
    expect(report.firmware.deviceIdMatchesBoard).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('different watch'))).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('desk'))).toBe(false);
  });

  it('falls back to the local file when the generated sdkconfig has no device id', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
    writeFileSync(workspace.firmwareFile, [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="desk"',
      '',
    ].join('\n'));
    // No generated sdkconfig on disk: the local file is the source of truth.
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-lcd-1.85c'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.effectiveDeviceId).toBe('desk');
    expect(report.firmware.effectiveDeviceIdSource).toBe('local');
    expect(report.firmware.deviceIdMatchesBoard).toBe(true);
  });

  it('reports effectiveDeviceIdSource as none when no file has a device id', async () => {
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
    writeFileSync(workspace.firmwareFile, [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      '',
    ].join('\n'));
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-lcd-1.85c'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.effectiveDeviceId).toBeNull();
    expect(report.firmware.effectiveDeviceIdSource).toBe('none');
    expect(report.firmware.deviceIdMatchesBoard).toBeNull();
  });

  it('still warns when the generated sdkconfig names a wrong-board device id', async () => {
    // The effective value (from the generated sdkconfig) does not match the
    // detected board's default. That is the real failure mode: the user has
    // flashed the wrong firmware or built for the wrong board, and the
    // doctor should call it out.
    const workspace = makeWorkspace();
    writeFileSync(workspace.macFile, `DEVICE_SHARED_SECRET=${SECRET}\n`, { mode: 0o600 });
    writeFileSync(workspace.firmwareFile, [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="kitchen"',
      '',
    ].join('\n'));
    writeFileSync(join(workspace.firmwareDir, 'sdkconfig'), [
      `CONFIG_VOICEMODE_URL="${ADDRESS}"`,
      `CONFIG_VOICEMODE_TOKEN="${SECRET}"`,
      'CONFIG_VOICEMODE_DEVICE_ID="kitchen"',
      '',
    ].join('\n'));
    const report = await runDoctor(optionsFor(workspace, {
      detectBoard: boardFixture('esp32-s3-touch-amoled-2.06'),
      fetchImpl: fetchWithRoutes(new Map([['http://127.0.0.1:8790/health', () => healthResponse(READY_BODY, 200)]])),
    }));
    expect(report.firmware.effectiveDeviceId).toBe('kitchen');
    expect(report.firmware.effectiveDeviceIdSource).toBe('generated');
    expect(report.firmware.deviceIdMatchesBoard).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('generated sdkconfig'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('different watch'))).toBe(true);
  });
});
