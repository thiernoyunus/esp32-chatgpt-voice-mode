/**
 * Asking a Codex program for its version, within a deadline.
 *
 * A version string is the only thing taken from the program, and only when it
 * looks exactly like the line Codex prints. Anything else - an unexpected
 * sentence, a token, a path - is discarded rather than reported, because it
 * could be text that was never meant to leave the program.
 */
import { existsSync } from 'node:fs';

export type CodexVersionProbe = {
  readonly present: boolean;
  readonly version: string | null;
  readonly timedOut: boolean;
  readonly failed: boolean;
};

/** Exactly one shape: the word Codex prints, then a version number. */
const CODEX_VERSION_LINE = /^codex-cli \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_VERSION_LENGTH = 120;

export function sanitizeVersionOutput(rawOutput: string): string | null {
  for (const line of rawOutput.split('\n')) {
    const cleaned = line.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (cleaned.length > 0 && cleaned.length <= MAX_VERSION_LENGTH && CODEX_VERSION_LINE.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

export async function probeCodexVersion(
  executablePath: string,
  timeoutMilliseconds = 5_000,
): Promise<CodexVersionProbe> {
  if (executablePath.trim().length === 0 || !existsSync(executablePath)) {
    return { present: false, version: null, timedOut: false, failed: false };
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executablePath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
  } catch {
    return { present: true, version: null, timedOut: false, failed: true };
  }
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // The process may have already exited; the timeout still stands.
    }
  }, timeoutMilliseconds);

  // A program that ignores the kill signal must not hang the check either.
  let exitCode: number | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    exitCode = await Promise.race([
      child.exited,
      new Promise<null>((resolve) => {
        exitTimer = setTimeout(() => resolve(null), timeoutMilliseconds + 1_000);
      }),
    ]);
  } finally {
    clearTimeout(killTimer);
    if (exitTimer !== undefined) {
      clearTimeout(exitTimer);
    }
  }
  if (timedOut || exitCode === null) {
    return { present: true, version: null, timedOut, failed: false };
  }

  // A program that left a child holding the output pipe must not hang either.
  let rawOutput = '';
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    rawOutput = await Promise.race([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Promise<string>((resolve) => {
        readTimer = setTimeout(() => resolve(''), 1_000);
      }),
    ]);
  } catch {
    rawOutput = '';
  } finally {
    if (readTimer !== undefined) {
      clearTimeout(readTimer);
    }
  }

  return {
    present: true,
    version: sanitizeVersionOutput(rawOutput),
    timedOut: false,
    failed: exitCode !== 0,
  };
}
