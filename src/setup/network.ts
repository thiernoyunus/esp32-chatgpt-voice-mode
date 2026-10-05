/** Reading this Mac's own address on the local network (read-only). */
import { spawnSync } from 'node:child_process';

export function detectLanAddress(): string | null {
  for (const device of ['en0', 'en1']) {
    try {
      const result = spawnSync('ipconfig', ['getifaddr', device], { encoding: 'utf8', timeout: 2_000 });
      if (result.status === 0 && typeof result.stdout === 'string') {
        const address = result.stdout.trim();
        if (address.length > 0) {
          return address;
        }
      }
    } catch {
      // Try the next interface.
    }
  }
  return null;
}
