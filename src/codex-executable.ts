/**
 * The one place that decides which Codex program to run.
 *
 * It mirrors what src/codex.ts does at startup, so the doctor checks the same
 * program the listener would actually launch:
 *
 *   1. VOICEMODE_CODEX_BIN, used exactly as given - including an empty value,
 *      which the runtime would also take literally and then fail to launch;
 *   2. the copy bundled inside the ChatGPT app, when it is there; otherwise
 *   3. the bare name "codex", which the operating system looks up on PATH.
 *
 * src/codex.ts imports this module's resolver for its app-server process, so
 * the runtime and the doctor share one decision and cannot drift apart.
 */
import { existsSync } from 'node:fs';

export const BUNDLED_CODEX_EXECUTABLE =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/** A bare name, not a path: the operating system resolves it from PATH. */
export const PATH_CODEX_EXECUTABLE = 'codex';

export type CodexExecutableSource = 'override' | 'bundled' | 'path';

export type CodexExecutableResolution = {
  readonly path: string;
  readonly source: CodexExecutableSource;
};

export function resolveCodexExecutable(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly bundledPath?: string;
  readonly fileExists?: (path: string) => boolean;
} = {}): CodexExecutableResolution {
  const environment = input.environment ?? process.env;
  const fileExists = input.fileExists ?? existsSync;

  const override = environment.VOICEMODE_CODEX_BIN;
  if (override !== undefined) {
    return { path: override, source: 'override' };
  }
  const bundledPath = input.bundledPath ?? BUNDLED_CODEX_EXECUTABLE;
  if (fileExists(bundledPath)) {
    return { path: bundledPath, source: 'bundled' };
  }
  return { path: PATH_CODEX_EXECUTABLE, source: 'path' };
}

/** The override, when set, is broken if it resolves to nothing runnable. */
export function isEmptyOverride(resolution: CodexExecutableResolution): boolean {
  return resolution.source === 'override' && resolution.path.trim().length === 0;
}
