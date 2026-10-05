/**
 * Input checks for the values that end up inside config files.
 *
 * The firmware file is line-based and quote-delimited, so a value carrying a
 * newline, a quote, or a backslash can break out of its line and change other
 * settings. Nothing here echoes the value it rejected, so a bad secret never
 * reaches a terminal or a log.
 */

import { isIP } from 'node:net';

const UNSAFE_IN_VALUE = /[\u0000-\u001f\u007f"\\]/;
const MAX_SECRET_LENGTH = 4_096;
const MAX_DEVICE_ID_LENGTH = 64;

export type HostValidation =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: string };

/**
 * A device address must be exactly a host name or IP address - no scheme,
 * credentials, port, path, query, or fragment. Anything else would be baked
 * into the device's URL and silently dial the wrong place.
 */
export function validateDeviceHost(rawHost: string): HostValidation {
  const host = rawHost.trim();
  if (host.length === 0) {
    return { ok: false, reason: 'No address for the device to dial. Pass --host with this Mac\'s network address.' };
  }
  if (/\s/.test(host) || UNSAFE_IN_VALUE.test(host)) {
    return { ok: false, reason: 'The address contains spaces or control characters.' };
  }
  if (host.includes('://')) {
    return { ok: false, reason: 'Give only the address, without a ws:// or http:// prefix.' };
  }
  if (/[/?#@]/.test(host)) {
    return { ok: false, reason: 'The address must be only a host name or IP address, with no path, query, or credentials.' };
  }
  if (host.startsWith('[')) {
    if (!host.endsWith(']') || isIP(host.slice(1, -1)) !== 6) {
      return { ok: false, reason: 'That is not a valid bracketed IPv6 address.' };
    }
    return { ok: true, host };
  }
  if (host.includes(':')) {
    return { ok: false, reason: 'Give the address without a port; pass --port separately.' };
  }
  if (host.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    return { ok: false, reason: 'The address must be a host name or IP address.' };
  }
  // A second opinion from the URL parser: it must round-trip to exactly what
  // was typed, with no hidden user, port, path, query, or fragment.
  let parsed: URL;
  try {
    parsed = new URL(`ws://${host}`);
  } catch {
    return { ok: false, reason: 'That is not a usable address.' };
  }
  if (
    parsed.host !== host ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return { ok: false, reason: 'The address must be only a host name or IP address.' };
  }
  return { ok: true, host };
}

/** Returns a safe explanation, or null when the secret can be stored. */
export function validateSecretValue(secret: string): string | null {
  if (secret.length === 0) {
    return 'The shared secret is empty.';
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return 'The shared secret is unreasonably long.';
  }
  if (UNSAFE_IN_VALUE.test(secret)) {
    return 'The shared secret contains characters that cannot be stored safely. Rotate it: delete both config files and run setup again.';
  }
  return null;
}

/** Returns a safe explanation, or null when the device id can be stored. */
export function validateDeviceId(deviceId: string): string | null {
  if (deviceId.length === 0) {
    return 'The device id is empty.';
  }
  if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
    return 'The device id is too long.';
  }
  if (UNSAFE_IN_VALUE.test(deviceId)) {
    return 'The device id contains characters that cannot be stored safely.';
  }
  return null;
}
