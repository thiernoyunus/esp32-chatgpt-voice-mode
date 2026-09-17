import { z } from 'zod';

import { realtimeStatusIconSchema } from './protocol';

export type RealtimeActivityIcon = z.infer<typeof realtimeStatusIconSchema>;

const appContextSchema = z.object({
  connectorId: z.string().min(1).max(128).optional(),
  appName: z.string().nullable().optional(),
  actionName: z.string().min(1).max(80).nullable().optional(),
});

const activityEventSchema = z.object({
  threadId: z.string().min(1),
  item: z.object({
    type: z.string(),
    server: z.string().optional(),
    tool: z.string().optional(),
    appContext: appContextSchema.nullable().optional(),
  }).optional(),
});

const GENERIC_TOOL_ACTION_MAP: ReadonlyMap<string, string> = new Map([
  ['search', 'Searching'],
  ['list', 'Listing'],
  ['read', 'Reading'],
  ['send', 'Sending'],
  ['create', 'Creating'],
  ['update', 'Updating'],
  ['delete', 'Deleting'],
]);

// Codex sends the raw tool identity ('gmail.search_email_ids'), never a phrase
// fit for the pill. Without this the screen shows the wire name verbatim.
function humanizeToolAction(raw: string): string {
  const action = raw.split('.').pop() ?? raw;
  const known = GENERIC_TOOL_ACTION_MAP.get(action);
  if (known !== undefined) return known;
  const words = action.replaceAll(/[_-]+/g, ' ').trim();
  if (words === '') return 'Using a tool…';
  const trimmed = words.replace(/\bids?$/i, '').trim() || words;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveGenericToolCaption(toolName: string | undefined): string {
  if (toolName === undefined) return 'Using a tool…';
  return humanizeToolAction(toolName);
}

function sanitizeCaption(raw: string): string {
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Using a tool…';
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 79) + '…';
}

export type RealtimeActivity = {
  readonly threadId: string;
  readonly caption: string;
  readonly icon?: RealtimeActivityIcon;
  readonly connectorId?: string;
};

export function readRealtimeActivity(method: string, params: unknown): RealtimeActivity | null {
  if (!['item/started', 'item/completed', 'turn/started', 'turn/completed'].includes(method)) {
    return null;
  }
  const parsed = activityEventSchema.safeParse(params);
  if (!parsed.success) return null;
  const { threadId, item } = parsed.data;
  if (method === 'turn/completed') return { threadId, caption: 'Listening' };
  if (method !== 'item/started') return { threadId, caption: 'Thinking…' };
  if (item?.type === 'agentMessage') return { threadId, caption: 'Answering…' };
  if (item?.type === 'webSearch') return { threadId, caption: 'Searching the web', icon: 'search' };
  if (item?.type === 'mcpToolCall') {
    const connectorId = item.appContext?.connectorId;
    const actionName = item.appContext?.actionName;
    if (actionName !== undefined && actionName !== null) {
      return {
        threadId,
        caption: sanitizeCaption(humanizeToolAction(actionName)),
        ...(connectorId !== undefined ? { connectorId } : {}),
      };
    }
    return { threadId, caption: resolveGenericToolCaption(item.tool), ...(connectorId !== undefined ? { connectorId } : {}) };
  }
  return { threadId, caption: 'Thinking…' };
}

export type ConnectorMetadata = {
  readonly connectorId: string;
  readonly iconUrl: string | null;
  readonly iconUrlDark: string | null;
};

const CONNECTOR_METADATA_CACHE_MAX_LENGTH = 32;
const CONNECTOR_METADATA_FETCH_TIMEOUT_MILLISECONDS = 5_000;

export class ConnectorMetadataCache {
  readonly #cache = new Map<string, ConnectorMetadata>();
  readonly #pendingMap = new Map<string, Promise<ConnectorMetadata | null>>();
  readonly #fetchConnectorMetadata: (
    connectorId: string,
    timeoutMilliseconds: number,
  ) => Promise<unknown>;

  constructor(
    fetchConnectorMetadata: (
      connectorId: string,
      timeoutMilliseconds: number,
    ) => Promise<unknown>,
  ) {
    this.#fetchConnectorMetadata = fetchConnectorMetadata;
  }

  get(connectorId: string): ConnectorMetadata | undefined {
    return this.#cache.get(connectorId);
  }

  async resolve(connectorId: string): Promise<ConnectorMetadata | null> {
    const cached = this.#cache.get(connectorId);
    if (cached !== undefined) return cached;
    const pending = this.#pendingMap.get(connectorId);
    if (pending !== undefined) return pending;
    if (this.#pendingMap.size >= 2) return null;
    const promise = this.#fetchAndCache(connectorId);
    this.#pendingMap.set(connectorId, promise);
    try {
      return await promise;
    } finally {
      this.#pendingMap.delete(connectorId);
    }
  }

  async #fetchAndCache(connectorId: string): Promise<ConnectorMetadata | null> {
    let rawResponse: unknown;
    try {
      rawResponse = await this.#fetchConnectorMetadata(
        connectorId,
        CONNECTOR_METADATA_FETCH_TIMEOUT_MILLISECONDS,
      );
    } catch {
      return null;
    }
    const metadata = parseConnectorMetadataResponse(connectorId, rawResponse);
    if (metadata === null) return null;
    this.#evictIfNeeded();
    this.#cache.set(connectorId, metadata);
    return metadata;
  }

  #evictIfNeeded(): void {
    if (this.#cache.size < CONNECTOR_METADATA_CACHE_MAX_LENGTH) return;
    const oldestKey = this.#cache.keys().next().value;
    if (oldestKey !== undefined) this.#cache.delete(oldestKey);
  }
}

// Codex reports built-in app icons as site-relative paths
// ('/images/ecosystem/apps/<app>/icon.png') and third-party ones as absolute
// URLs. Requiring an absolute URL rejected every built-in app, which is why no
// icon ever reached the device.
const iconReferenceSchema = z.string().min(1).max(2048).nullable().optional();

const connectorMetadataEntrySchema = z.object({
  id: z.string().min(1),
  iconUrl: iconReferenceSchema,
  iconUrlDark: iconReferenceSchema,
});

const CODEX_APP_ICON_BASE_URL = 'https://chatgpt.com';

function toAbsoluteIconUrl(reference: string | null | undefined): string | null {
  if (reference === null || reference === undefined || reference === '') return null;
  try {
    return new URL(reference, CODEX_APP_ICON_BASE_URL).toString();
  } catch {
    return null;
  }
}

const connectorMetadataResponseSchema = z.object({
  apps: z.array(connectorMetadataEntrySchema).max(10),
});

function parseConnectorMetadataResponse(
  connectorId: string,
  rawResponse: unknown,
): ConnectorMetadata | null {
  const parsed = connectorMetadataResponseSchema.safeParse(rawResponse);
  if (!parsed.success) return null;
  const entry = parsed.data.apps.find((app) => app.id === connectorId);
  if (entry === undefined) return null;
  return {
    connectorId: entry.id,
    iconUrl: toAbsoluteIconUrl(entry.iconUrl),
    iconUrlDark: toAbsoluteIconUrl(entry.iconUrlDark),
  };
}


export function resolveConnectorMetadataUrl(
  cache: ConnectorMetadataCache,
  connectorId: string,
): string | null {
  const metadata = cache.get(connectorId);
  if (metadata === undefined) return null;
  return metadata.iconUrlDark ?? metadata.iconUrl ?? null;
}
