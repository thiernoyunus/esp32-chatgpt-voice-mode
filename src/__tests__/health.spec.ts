import { describe, expect, it } from 'bun:test';
import { ListenerHealth } from '../health';
import { classifyVoiceFailure } from '../failures';

describe('local readiness report', () => {
  const get = () => new Request('http://localhost:8790/health');
  it('does not call a starting companion ready or claim speaker success', async () => {
    const health = new ListenerHealth();
    expect(health.response(get(), true, false, 0).status).toBe(503);
    health.ready();
    const response = health.response(get(), true, true, 1);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      service: 'esp32-voice-mode', schemaVersion: 1, companion: { status: 'ready' },
      device: { connected: true }, calls: { active: 1 }, lastError: null,
    });
  });
  it('refuses remote and write requests', () => {
    const health = new ListenerHealth();
    expect(health.response(get(), false, false, 0).status).toBe(403);
    expect(health.response(new Request(get(), { method: 'POST' }), true, false, 0).status).toBe(405);
  });
  it('keeps raw private error content out of the response', async () => {
    const health = new ListenerHealth();
    health.ready();
    health.noteCallFailure('unexpected error at /Users/private/chat token=secret transcript=hello');
    const response = health.response(get(), true, false, 0);
    expect(response.status).toBe(200); // A failed call does not imply a dead companion.
    const text = await response.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('transcript');
    health.clearCallFailure();
    expect(await health.response(get(), true, false, 0).json()).toMatchObject({ lastError: null });
    health.failed('app-server stopped (1)');
    expect(health.response(get(), true, false, 0).status).toBe(503);
  });
});

describe('actionable voice failures', () => {
  it.each([
    ['Unknown voice model: old-model. Available: current-model', 'model_unavailable'],
    ['Voice model catalog unavailable; refusing explicit model', 'catalog_unavailable'],
    ['failed to load configuration: Operation not permitted', 'permission_denied'],
    ['HTTP 401 unauthorized', 'sign_in_required'],
    ['Realtime request timed out', 'setup_timeout'],
    ['spawn codex ENOENT', 'codex_missing'],
    ['Codex app-server stopped (1).', 'codex_disconnected'],
    ['ChatGPT Voice closed: transport_closed', 'voice_connection_lost'],
    ['429 Too Many Requests', 'usage_limit'],
    ['unexpected private failure', 'voice_failed'],
  ])('%s gives an actionable category', (input, code) => {
    expect(classifyVoiceFailure(input).code).toBe(code);
    expect(classifyVoiceFailure(input).message.length).toBeLessThan(100);
  });
});
