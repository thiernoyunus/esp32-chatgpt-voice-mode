import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Put new voice chats beside Codex Desktop's projectless chats. */
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
  let codexConfig: string;
  try {
    codexConfig = readFileSync(join(environment.CODEX_HOME?.trim() || join(home, '.codex'), 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    codexConfig = '';
  }
  if (codexConfig) {
    const desktop = (Bun.TOML.parse(codexConfig) as { desktop?: { projectlessWorkspaceRoot?: unknown } }).desktop;
    const projectlessRoot = desktop?.projectlessWorkspaceRoot;
    if (typeof projectlessRoot === 'string' && projectlessRoot.trim()) {
      if (!isAbsolute(projectlessRoot)) {
        throw new Error('Codex projectless task folder must be an absolute path.');
      }
      return projectlessRoot;
    }
  }
  return join(home, 'Documents', 'Codex');
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
