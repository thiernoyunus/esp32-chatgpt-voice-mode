import { spawn } from 'node:child_process';

const ALLOWED_ICON_HOST_SUFFIX_LIST: readonly string[] = [
  '.oaistatic.com',
  '.openai.com',
  '.oaiusercontent.com',
  '.chatgpt.com',
];
const ICON_FETCH_TIMEOUT_MILLISECONDS = 5_000;
const ICON_FETCH_MAX_BYTES = 256 * 1024;
const ICON_EXPECTED_RAW_BYTES = 24 * 24 * 4;
const ICON_EXPECTED_BASE64_LENGTH = 3072;
const ICON_MAX_INPUT_DIMENSION = 2048;
// Homebrew's path on this machine. Anywhere else, point APOLLO_MAGICK_BIN at
// the binary; a missing one only costs the icon, which falls back to text.
const MAGICK_BIN = process.env.APOLLO_MAGICK_BIN ?? '/opt/homebrew/bin/magick';
const MAGICK_LIMITS: readonly string[] = [
  '-limit', 'memory', '32MiB',
  '-limit', 'map', '0',
  '-limit', 'disk', '0',
];
const ICON_CONCURRENCY_MAX = 2;
const ICON_CACHE_MAX_LENGTH = 32;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function isAllowedIconUrl(urlString: string): boolean {
  if (urlString.length > 2048) return false;
  let url: URL;
  try { url = new URL(urlString); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  if (url.username !== '' || url.password !== '') return false;
  const hostname = url.hostname;
  for (const suffix of ALLOWED_ICON_HOST_SUFFIX_LIST) {
    const bare = suffix.slice(1);
    if (hostname === bare || hostname.endsWith(suffix)) return true;
  }
  return false;
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function validatePngIhdr(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  if (bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13) return false;
  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return false;
  return true;
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (width <= 0 || height <= 0) return null;
  if (width > ICON_MAX_INPUT_DIMENSION || height > ICON_MAX_INPUT_DIMENSION) return null;
  return { width, height };
}

async function fetchIconBytes(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MILLISECONDS);
  try {
    // Send no browser-imitating headers: the icon host rejects a spoofed
    // desktop User-Agent with 403 while serving the plain request.
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'image/png,image/*;q=0.8' },
    });
    if (!response.ok) return null;
    const body = response.body;
    if (body === null) return null;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        totalBytes += value.length;
        if (totalBytes > ICON_FETCH_MAX_BYTES) {
          controller.abort();
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ponytail: bounded counter, no queue; reject when at capacity
let activeMagickCount = 0;

function tryAcquireMagickSlot(): boolean {
  if (activeMagickCount >= ICON_CONCURRENCY_MAX) return false;
  activeMagickCount++;
  return true;
}

function releaseMagickSlot(): void {
  activeMagickCount--;
}

export async function convertPngToIconPixels(pngBytes: Uint8Array): Promise<string | null> {
  if (pngBytes.length > ICON_FETCH_MAX_BYTES) return null;
  if (!hasPngSignature(pngBytes)) return null;
  if (!validatePngIhdr(pngBytes)) return null;
  if (readPngDimensions(pngBytes) === null) return null;
  if (!tryAcquireMagickSlot()) return null;
  try {
    return await new Promise<string | null>((resolve) => {
      const child = spawn(MAGICK_BIN, [
        ...MAGICK_LIMITS,
        'PNG:-',
        '-resize', '24x24',
        '-background', 'rgba(0,0,0,0)',
        '-gravity', 'center',
        '-extent', '24x24',
        '-depth', '8',
        'BGRA:-',
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL' });
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > ICON_EXPECTED_RAW_BYTES) { child.kill('SIGKILL'); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', () => {});
      const processTimeout = setTimeout(() => {
        try { child.kill(); } catch {}
      }, ICON_FETCH_TIMEOUT_MILLISECONDS);
      child.on('error', () => { clearTimeout(processTimeout); resolve(null); });
      child.on('close', (code) => {
        clearTimeout(processTimeout);
        if (code !== 0 || stdoutBytes !== ICON_EXPECTED_RAW_BYTES) { resolve(null); return; }
        const raw = Buffer.concat(chunks);
        if (raw.length !== ICON_EXPECTED_RAW_BYTES) { resolve(null); return; }
        const base64 = raw.toString('base64');
        if (base64.length !== ICON_EXPECTED_BASE64_LENGTH) { resolve(null); return; }
        resolve(base64);
      });
      child.stdin.on('error', () => {});
      child.stdin.write(pngBytes);
      child.stdin.end();
    });
  } finally {
    releaseMagickSlot();
  }
}

const iconPixelCache = new Map<string, string>();
const iconPendingMap = new Map<string, Promise<string | null>>();

function evictOldestIcon(): void {
  if (iconPixelCache.size < ICON_CACHE_MAX_LENGTH) return;
  const oldestKey = iconPixelCache.keys().next().value;
  if (oldestKey !== undefined) iconPixelCache.delete(oldestKey);
}

export async function resolveIconPixels(url: string): Promise<string | null> {
  const cached = iconPixelCache.get(url);
  if (cached !== undefined) return cached;
  const pending = iconPendingMap.get(url);
  if (pending !== undefined) return pending;
  if (iconPendingMap.size >= ICON_CONCURRENCY_MAX) return null;
  const promise = fetchConvertAndCacheIcon(url);
  iconPendingMap.set(url, promise);
  try { return await promise; } finally { iconPendingMap.delete(url); }
}

async function fetchConvertAndCacheIcon(url: string): Promise<string | null> {
  if (!isAllowedIconUrl(url)) return null;
  const bytes = await fetchIconBytes(url);
  if (bytes === null) return null;
  const base64 = await convertPngToIconPixels(bytes);
  if (base64 === null) return null;
  evictOldestIcon();
  iconPixelCache.set(url, base64);
  return base64;
}

export function clearIconPixelCache(): void {
  iconPixelCache.clear();
}

export function getIconCacheSize(): number {
  return iconPixelCache.size;
}

export async function forwardActivityIcon(
  pixels: Promise<string | null>,
  isCurrent: () => boolean,
  send: (value: string) => void,
): Promise<void> {
  try {
    const value = await pixels;
    if (value !== null && isCurrent()) send(value);
  } catch { /* An unavailable icon must not interrupt the call. */ }
}
