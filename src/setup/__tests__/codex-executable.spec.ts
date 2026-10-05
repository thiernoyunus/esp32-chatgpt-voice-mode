import { describe, expect, it } from 'bun:test';

import {
  BUNDLED_CODEX_EXECUTABLE,
  PATH_CODEX_EXECUTABLE,
  isEmptyOverride,
  resolveCodexExecutable,
} from '../../codex-executable';

describe('choosing the Codex program, the way the listener does', () => {
  it('uses the bundled copy when it exists', () => {
    const resolution = resolveCodexExecutable({ environment: {}, fileExists: () => true });
    expect(resolution).toEqual({ path: BUNDLED_CODEX_EXECUTABLE, source: 'bundled' });
  });

  it('falls back to the bare name on PATH when the bundled copy is gone', () => {
    const resolution = resolveCodexExecutable({ environment: {}, fileExists: () => false });
    expect(resolution).toEqual({ path: PATH_CODEX_EXECUTABLE, source: 'path' });
  });

  it('uses VOICEMODE_CODEX_BIN exactly as given, including an empty value', () => {
    expect(resolveCodexExecutable({ environment: { VOICEMODE_CODEX_BIN: '/custom/codex' }, fileExists: () => true }))
      .toEqual({ path: '/custom/codex', source: 'override' });
    expect(resolveCodexExecutable({ environment: { VOICEMODE_CODEX_BIN: '  /spaced/codex  ' }, fileExists: () => true }))
      .toEqual({ path: '  /spaced/codex  ', source: 'override' });

    const empty = resolveCodexExecutable({ environment: { VOICEMODE_CODEX_BIN: '' }, fileExists: () => true });
    expect(empty).toEqual({ path: '', source: 'override' });
    expect(isEmptyOverride(empty)).toBe(true);
  });

  it('does not treat a missing override as an empty one', () => {
    expect(isEmptyOverride(resolveCodexExecutable({ environment: {}, fileExists: () => true }))).toBe(false);
  });
});
