/**
 * Asking a running listener how it is doing, from this Mac only.
 *
 * Two shapes of reply are understood:
 *
 *   - the current /health report, which must identify itself as
 *     esp32-voice-mode schema 1; and
 *   - an old listener, which answers 404 there but still answers / - that only
 *     proves a process is listening, nothing more.
 *
 * Every request is bounded in total time and in how much of the reply is read,
 * so a stalled or endless response cannot hang the check. Nothing from the
 * reply is passed through wholesale: the failure line is rebuilt from a fixed
 * table so private text in it can never surface here.
 */

export type CompanionStatus = 'starting' | 'ready' | 'failed';

export type ListenerHealthFacts = {
  readonly service: 'esp32-voice-mode';
  readonly schemaVersion: 1;
  readonly companionStatus: CompanionStatus | null;
  readonly deviceConnected: boolean | null;
  readonly activeCalls: number | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
};

export const EXPECTED_SERVICE = 'esp32-voice-mode';
export const EXPECTED_SCHEMA_VERSION = 1;

/**
 * The only failure text this tool will ever show. The codes are the closed set
 * the listener already classifies into; the wording is rebuilt here rather than
 * copied from the reply, which may hold a private path, a token, or a sentence.
 */
const SAFE_FAILURE_MESSAGE: Record<string, string> = {
  usage_limit: 'ChatGPT is limiting voice use right now. Try again in a little while.',
  catalog_unavailable: 'Can\'t load the voice list. Make sure Codex is open on your Mac, then tap to try again.',
  model_unavailable: 'That voice isn\'t available. Pick another one in Settings.',
  permission_denied: 'Codex can\'t open its chat folder on your Mac. Run bun run doctor there.',
  sign_in_required: 'Codex isn\'t signed in on your Mac. Open the Codex app and sign in.',
  setup_timeout: 'Your Mac took too long to answer. Tap to try again.',
  codex_missing: 'Codex can\'t start on your Mac. Run bun run doctor there.',
  codex_disconnected: 'Lost the connection to Codex on your Mac. Tap to try again.',
  voice_connection_lost: 'The voice call dropped. Tap to try again.',
  voice_failed: 'Voice couldn\'t start. Tap to try again, or run bun run doctor on your Mac.',
};

const GENERIC_FAILURE_CODE = 'voice_failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hosts that mean "this Mac". 0.0.0.0 is normalised to 127.0.0.1. */
export function loopbackFetchHost(host: string): string | null {
  const cleaned = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (cleaned === 'localhost' || cleaned === '::1' || cleaned === '0.0.0.0') {
    return cleaned === '::1' ? '[::1]' : '127.0.0.1';
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

function readCompanionStatus(value: unknown): CompanionStatus | null {
  return value === 'starting' || value === 'ready' || value === 'failed' ? value : null;
}

function readSafeLastError(raw: unknown): { code: string; message: string } | null {
  if (!isRecord(raw) || typeof raw.code !== 'string') {
    return null;
  }
  const code = Object.prototype.hasOwnProperty.call(SAFE_FAILURE_MESSAGE, raw.code)
    ? raw.code
    : GENERIC_FAILURE_CODE;
  return { code, message: SAFE_FAILURE_MESSAGE[code] ?? SAFE_FAILURE_MESSAGE[GENERIC_FAILURE_CODE]! };
}

/**
 * Copy known, harmless fields out of a /health reply, and only if the reply
 * actually identifies itself as this service at the expected version. Anything
 * else - a different service, a different schema, junk - reads as no report.
 */
export function readListenerHealthFacts(raw: unknown): ListenerHealthFacts | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.service !== EXPECTED_SERVICE || raw.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    return null;
  }
  const companion = raw.companion;
  const device = raw.device;
  const calls = raw.calls;
  return {
    service: EXPECTED_SERVICE,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    companionStatus: isRecord(companion) ? readCompanionStatus(companion.status) : null,
    deviceConnected: isRecord(device) && typeof device.connected === 'boolean' ? device.connected : null,
    activeCalls: isRecord(calls) && Number.isInteger(calls.active) ? (calls.active as number) : null,
    lastError: readSafeLastError(raw.lastError),
  };
}

export type ListenerProbe = {
  /** True when the requested host was not this Mac, so no request was sent. */
  readonly skipped: boolean;
  readonly reachable: boolean;
  readonly status: number | null;
  readonly facts: ListenerHealthFacts | null;
  /** An older listener: no /health, but a process answers /. */
  readonly oldListener: boolean;
  /** Anything answered at /, which proves only that a process is listening. */
  readonly processPresent: boolean;
  readonly timedOut: boolean;
};

const DEFAULT_TIMEOUT_MILLISECONDS = 3_000;
const MAX_BODY_BYTES = 16_384;

type BoundedReply = {
  readonly status: number | null;
  readonly text: string | null;
  readonly timedOut: boolean;
};

async function readBodyText(response: Response, maximumBytes: number): Promise<string | null> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return text.length > maximumBytes ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already closed; the oversized reply is simply discarded.
        }
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Nothing else reads this body.
    }
  }
  return text;
}

/**
 * Resolve with the promise's value, or with null once the budget runs out.
 * A stalled read cannot be interrupted by the network signal alone - a body
 * that never ends does not listen to it - so the deadline is enforced here.
 */
function withinBudget<T>(
  promise: Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        onTimeout();
        resolve(null);
      }
    }, Math.max(0, milliseconds));
    const finish = (value: T | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    promise.then((value) => finish(value), () => finish(null));
  });
}

/**
 * One request, bounded end to end: the deadline covers both waiting for the
 * reply and reading its body, and only a fixed amount of body is accepted.
 */
async function requestBounded(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMilliseconds: number,
): Promise<BoundedReply> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const noteTimeout = (): void => {
    timedOut = true;
    controller.abort();
  };
  const remainingBudget = (): number => Math.max(0, timeoutMilliseconds - (Date.now() - startedAt));
  const abortTimer = setTimeout(noteTimeout, timeoutMilliseconds);
  try {
    const response = await withinBudget(
      fetchImpl(url, { signal: controller.signal, redirect: 'error' }),
      remainingBudget(),
      noteTimeout,
    );
    if (response === null) {
      return { status: null, text: null, timedOut };
    }
    const text = await withinBudget(readBodyText(response, MAX_BODY_BYTES), remainingBudget(), noteTimeout);
    return { status: response.status, text, timedOut };
  } catch {
    return { status: null, text: null, timedOut };
  } finally {
    clearTimeout(abortTimer);
  }
}

function parseFacts(text: string | null): ListenerHealthFacts | null {
  if (text === null) {
    return null;
  }
  try {
    return readListenerHealthFacts(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function probeListener(input: {
  readonly host: string;
  readonly port: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}): Promise<ListenerProbe> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMilliseconds = input.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const fetchHost = loopbackFetchHost(input.host);
  if (fetchHost === null) {
    return { skipped: true, reachable: false, status: null, facts: null, oldListener: false, processPresent: false, timedOut: false };
  }
  const base = `http://${fetchHost}:${input.port}`;
  const health = await requestBounded(fetchImpl, `${base}/health`, timeoutMilliseconds);

  if (health.status !== null && health.status !== 404) {
    const facts = health.status === 200 || health.status === 503 ? parseFacts(health.text) : null;
    return {
      skipped: false,
      reachable: true,
      status: health.status,
      facts,
      oldListener: false,
      processPresent: true,
      timedOut: health.timedOut,
    };
  }

  // Nothing useful on /health: an old listener still proves it exists on /.
  const root = await requestBounded(fetchImpl, `${base}/`, timeoutMilliseconds);
  const processPresent = root.status === 200;
  return {
    skipped: false,
    reachable: processPresent,
    status: health.status,
    facts: null,
    oldListener: processPresent,
    processPresent,
    timedOut: health.status === null ? health.timedOut : root.timedOut,
  };
}
