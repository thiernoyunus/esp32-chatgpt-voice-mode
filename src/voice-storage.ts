import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Keep background-service files out of macOS's protected Documents folder. */
export function voiceStorageRoot(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const configured = environment.VOICEMODE_CODEX_ROOT?.trim() ||
    environment.VOICEMODE_CODEX_CWD?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error('VOICEMODE_CODEX_ROOT must be an absolute folder path.');
    }
    return configured;
  }
  return join(home, 'Library', 'Application Support', 'ESP32 Voice Mode', 'chats');
}

export function voiceStorageError(root: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Codex cannot open the voice chat folder "${root}": ${detail}. ` +
    'Check the folder permissions. If it is in Documents or Desktop, grant the ' +
    'background service access in macOS Privacy & Security, or reinstall with ' +
    'VOICEMODE_CODEX_ROOT set to a folder intended for this service. ' +
    'Existing chats have not been moved.',
  );
}
