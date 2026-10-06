import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { Database } from 'bun:sqlite';
import { z } from 'zod';

import {
  CLIENT_VERSION,
  type CodexBridgeMessage,
  type CodexBridgeRealtimeRequest,
} from './codex-events';
import { readRealtimeActivity, ConnectorMetadataCache } from './activity';
import { forwardActivityIcon, resolveIconPixels } from './icons';
import { voiceStorageError } from './voice-storage';
import { releaseVoiceChat } from './voice-release';
import { classifyVoiceFailure } from './failures';
import { DesktopCodexProcess } from './desktop-core';

const CODEX_APP_SERVER_REQUEST_TIMEOUT_MILLISECONDS = 45_000;
// Catalog fetch is bounded well under the 30s realtime_offer readiness window so
// a slow model/list cannot stall the device setup; one failed fetch only
// disables discovery for the cooldown, not for the lifetime of the bridge.
const VOICE_MODEL_CATALOG_FETCH_TIMEOUT_MILLISECONDS = 5_000;
const VOICE_MODEL_CATALOG_FAILURE_COOLDOWN_MILLISECONDS = 30_000;
const RECENT_CHAT_CACHE_LIFETIME_MILLISECONDS = 30_000;
const CODEX_APP_SERVER_REALTIME_TIMEOUT_MILLISECONDS = 40_000;
// Recent-chat picker size: the watch shows a short scrollable list, not a
// full history browser.
const RECENT_CHAT_LIST_SIZE = 20;

/**
 * Settings handed to the Codex app-server at startup.
 *
 * Reasoning follows the device preference, then Codex configuration, then low.
 * Model selection is independent; unsupported reasoning choices are rejected.
 *
 *   VOICEMODE_CODEX_MODEL        pin a model, e.g. gpt-6-luna. Left unset,
 *                                Codex uses whatever the user configured.
 *   VOICEMODE_CODEX_DISABLE_MCP  comma-separated MCP servers to switch off for
 *                                calls only. Useful for ones that are slow to
 *                                start, since every one of them delays the
 *                                first call after a restart.
 */
export function buildCodexOverrides(): string[] {
  const overrides = ['-c', 'thread_unload_delay_secs=0'];
  const model = process.env.VOICEMODE_CODEX_MODEL;
  if (model !== undefined && model.length > 0) {
    overrides.push('-c', `model="${model}"`);
  }
  for (const name of (process.env.VOICEMODE_CODEX_DISABLE_MCP ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)) {
    overrides.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  return overrides;
}
const CODEX_DEVELOPER_INSTRUCTION_LIST = [
  'You are the local Codex agent behind the voice device on this desk.',
  'Answer the user directly in clear English. Keep the spoken answer short and conversational; do not use Markdown.',
  'Use the MCP servers and plugins configured on this Mac when they fit the request. Do not claim an action succeeded unless the tool confirms it.',
  'For Codex projects, folders, and chats, use the Codex app tools: list_projects to find the project, list_threads or read_thread to inspect chats, and create_thread to start a task in the requested project. Saved notes are not a live project list. If the app tools fail, report the tool error instead of claiming the folder is missing.',
  'To create a local project task, call create_thread with target: { type: "project", projectId: the ID returned by list_projects, environment: { type: "local" } }, plus prompt and optional title. The projectId belongs inside target.',
  // Without naming it, the model answers questions about the device from
  // nowhere: asked its volume it will state a number it never looked up, and
  // asked to change it will say it did. Both were observed.
  'The device you are speaking through has controls under the "desk" tool server: its volume, its screen brightness, and a capture of its screen. Anything about the device itself is answered by calling those, never from memory. Volume and brightness are absolute 0-100 values, so read the status first before making something louder or dimmer.',
  // Everything the user says arrives as speech. There is no second channel
  // carrying chat history or app context any more, so an instruction telling
  // the model to look for one only invites it to invent one.
  'Everything reaching you is spoken out loud by a person standing at the device.',
  // The person is not in the repository this process happens to run in, and any
  // place named in these files answers for somebody else.
  'If you do not know where the person is, ask them. Never take their location from files in this repository.',
];

/**
 * What Codex is told before a call starts.
 *
 * There used to be a line here naming the city the desk sits in, so the
 * assistant could answer about weather and local time without asking. It was
 * supplied by the Cloudflare Worker and went away with it. The instruction
 * below to ask rather than guess is what covers that now; to put the place
 * back, add it to this list.
 */
function buildCodexDeveloperInstructions(): string {
  return CODEX_DEVELOPER_INSTRUCTION_LIST.join('\n\n');
}

const codexMessageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string().optional() }).optional(),
  })
  .passthrough();






const realtimeSdpSchema = z.object({
  threadId: z.string().min(1),
  sdp: z.string().min(1).max(64_000),
});

const realtimeErrorSchema = z.object({
  threadId: z.string().min(1),
  message: z.string().min(1),
});

const realtimeClosedSchema = z.object({
  threadId: z.string().min(1),
  reason: z.string().nullable(),
});

const realtimeTranscriptDoneSchema = z.object({
  threadId: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});

const realtimeTranscriptDeltaSchema = z.object({
  threadId: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  delta: z.string(),
});

// Voice model catalog: pulled from the Codex app-server `model/list` request and
// used to validate the `model` field a device puts on a realtime offer. The
// choice id the device receives is `entry.model`, not the app-server's display
// id — callers wire that into `thread/start` config and it must stay stable.
export type VoiceModelCatalogEntry = {
  readonly isDefault?: boolean;
  readonly model: string;
  readonly displayName: string | null;
  readonly supportedReasoningEffortList: readonly string[];
  readonly defaultReasoningEffort: string | null;
};

export type VoiceModelChoice = {
  readonly id: string;
  readonly name: string;
};

export type VoiceModelResolution =
  | { readonly kind: 'absent' }
  | { readonly kind: 'catalog_unavailable'; readonly requestedModel: string }
  | {
      readonly kind: 'unknown';
      readonly requestedModel: string;
      readonly knownModelList: readonly string[];
    }
  | {
      readonly kind: 'resolved';
      readonly entry: VoiceModelCatalogEntry;
    };

const VOICE_MODEL_ID_MAX_LENGTH = 128;
const VOICE_MODEL_NAME_MAX_LENGTH = 80;
const VOICE_MODEL_CATALOG_MAX_LENGTH = 40;

// The installed app-server reports each effort as `{ reasoningEffort,
// description }`, not a bare string. We strip down to the effort name.
const reasoningEffortSchema = z
  .object({ reasoningEffort: z.string().min(1) })
  .passthrough();

// `model/list` returns the full model surface; we only need a handful of fields
// to choose a voice model and pick a reasoning effort. Extra fields stay on the
// raw entry so a richer app-server build can still drive the bridge.
const modelListEntrySchema = z
  .object({
    model: z.string().min(1).max(VOICE_MODEL_ID_MAX_LENGTH),
    isDefault: z.boolean().optional(),
    displayName: z.string().min(1).max(VOICE_MODEL_NAME_MAX_LENGTH).optional(),
    supportedReasoningEfforts: z.array(reasoningEffortSchema).optional(),
    defaultReasoningEffort: z.string().min(1).optional(),
  })
  .passthrough();

// The wrapper holds `nextCursor` for pagination; tolerate unknown keys so a
// newer app-server build does not break the bridge by adding one.
const modelListResponseSchema = z.union([
  z
    .object({
      data: z.array(modelListEntrySchema).max(VOICE_MODEL_CATALOG_MAX_LENGTH),
    })
    .passthrough(),
  z.array(modelListEntrySchema).max(VOICE_MODEL_CATALOG_MAX_LENGTH),
]);

export function parseVoiceModelCatalog(
  rawResponse: unknown,
): VoiceModelCatalogEntry[] | null {
  const parsed = modelListResponseSchema.safeParse(rawResponse);
  if (!parsed.success) return null;
  const rawList: ReadonlyArray<z.infer<typeof modelListEntrySchema>> = Array.isArray(
    parsed.data,
  )
    ? parsed.data
    : parsed.data.data;
  return rawList.map((entry) => ({
    model: entry.model,
    isDefault: entry.isDefault,
    displayName: entry.displayName ?? null,
    supportedReasoningEffortList: (entry.supportedReasoningEfforts ?? []).map(
      (entry) => entry.reasoningEffort,
    ),
    defaultReasoningEffort: entry.defaultReasoningEffort ?? null,
  }));
}

export function buildVoiceModelChoiceList(
  catalog: readonly VoiceModelCatalogEntry[],
): VoiceModelChoice[] {
  return catalog.map((entry) => ({
    id: entry.model,
    name: entry.displayName ?? entry.model,
  }));
}

// Voices a v3 ChatGPT Voice call accepts, from the app-server's own v1 set
// (`thread/realtime/listVoices`). The device sends a display name; anything
// unknown falls back to the default rather than failing the call.
export const REALTIME_VOICE_LIST = [
  'cove',
  'juniper',
  'maple',
  'spruce',
  'ember',
  'vale',
  'breeze',
  'arbor',
  'sol',
] as const;
export const DEFAULT_REALTIME_VOICE = 'cove';

export function resolveRealtimeVoice(requested: string | undefined): string {
  const wanted = (requested ?? '').trim().toLowerCase();
  return REALTIME_VOICE_LIST.find((voice) => voice === wanted) ?? DEFAULT_REALTIME_VOICE;
}

// A chat the watch can reopen. `name` is what the user sees; Codex names a
// thread after its first turn, so a brand-new chat can still be unnamed.
export type VoiceChatChoice = {
  readonly id: string;
  readonly name: string;
  // The sidebar section when Codex has one; otherwise the chat's working
  // folder name. The device uses this as the small right-hand label.
  readonly folder?: string;
};

/**
 * Should this offer continue the chat the previous attempt opened?
 *
 * The desk device talks over a watchful radio link: if an answer does not
 * arrive quickly enough - or if the call fails outright - it dials again, with
 * a fresh offer and a fresh request id but the same human intent. Nothing in
 * that second offer says "this is a retry", so the bridge has to work it out:
 * it is a retry when the previous attempt opened a chat that never actually
 * came up, and the caller did not name a chat of its own to open.
 *
 * Reusing the chat is what keeps one spoken conversation in one chat. Treating
 * the retry as a new call leaves an abandoned "Desk voice chat" behind for
 * every attempt the device made while it was waiting.
 */
export function decideThreadReuse(input: {
  // The chat the previous attempt opened, whether that attempt is still
  // sitting here live or has already failed and been put aside.
  readonly previousThreadId: string | null;
  readonly previousCallCameUp: boolean;
  readonly requestedThreadId: string | undefined;
}): string | null {
  return input.previousThreadId !== null &&
    !input.previousCallCameUp &&
    input.requestedThreadId === undefined
    ? input.previousThreadId
    : null;
}

// Codex titles a chat from its first turn, but a voice turn arrives as audio,
// so the chat would stay untitled in the sidebar. Use the opening sentence.
// ponytail: first-sentence heuristic; swap for a model-written title only if
// these names read badly in practice.
export function buildChatNameFromSpeech(text: string): string | null {
  const spoken = text.replace(/\s+/g, ' ').trim();
  if (spoken.length === 0) return null;
  const firstSentence = spoken.split(/(?<=[.!?])\s/)[0] ?? spoken;
  const name = (firstSentence.length <= 60 ? firstSentence : spoken.slice(0, 57).trimEnd() + '…')
    .replace(/[.!?,;:\s]+$/, '');
  return name.length === 0 ? null : name;
}

// A desk call's title, so its sidebar row is recognisable at a glance. Without
// this the rows are named after whatever was said first - "Um", "friend" - and
// a finished call is impossible to pick out of Recents. The clock stands in
// until the user says something worth naming the call after.
export function buildDeskCallTitle(spokenName: string | null): string {
  const clock = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return spokenName === null ? `Desk call · ${clock}` : `Desk call · ${spokenName}`;
}

/**
 * Make a voice chat's folder the way the desktop app makes its own.
 *
 * The app gives the day's first chat a folder called `realtime-voice-chat`,
 * numbers the next one `-2`, then `-3`, and puts a `work` folder and an
 * `outputs` folder inside. The bridge used to take the plain name and leave it
 * empty, so a desk chat's folder was the one folder in Finder you could pick
 * out by eye.
 */
export function createVoiceChatFolder(root: string, now = new Date()): string {
  const dateStamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const dayFolder = join(root, dateStamp);
  mkdirSync(dayFolder, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0
      ? 'realtime-voice-chat'
      : `realtime-voice-chat-${attempt + 1}`;
    const folder = join(dayFolder, name);
    try {
      mkdirSync(folder, { recursive: false });
    } catch {
      // That name is taken. Take the next number, the way the app does.
      continue;
    }
    try {
      mkdirSync(join(folder, 'work'), { recursive: false });
      mkdirSync(join(folder, 'outputs'), { recursive: false });
    } catch {
      // A chat whose folder cannot hold work and outputs is still a chat.
    }
    return folder;
  }
  const fallback = join(dayFolder, `realtime-voice-chat-${Date.now().toString(36)}`);
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

const threadListResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().nullable().optional(),
        preview: z.string().nullable().optional(),
        ephemeral: z.boolean().optional(),
        cwd: z.string().nullish(),
        section: z.object({ name: z.string().min(1) }).nullish(),
      })
      .passthrough(),
  ),
});

type StateChatRow = {
  readonly id: string;
  readonly name: string | null;
  readonly preview: string | null;
  readonly cwd: string | null;
  readonly section_name: string | null;
  readonly project_name: string | null;
};

function folderLabel(
  sectionName: string | null | undefined,
  projectName: string | null | undefined,
  cwd: string | null | undefined,
): string | undefined {
  const section = sectionName?.trim();
  if (section) return section.slice(0, 60);
  const project = projectName?.trim();
  if (project) return project.slice(0, 60);
  const pathParts = cwd?.split('/').filter((part) => part.length > 0);
  const folder = pathParts?.at(-1)?.trim();
  return folder === undefined || folder.length === 0 ? undefined : folder.slice(0, 60);
}

function readStateDatabaseChatList(): VoiceChatChoice[] {
  const codexHome = process.env.CODEX_HOME ?? `${homedir()}/.codex`;
  let database: Database | null = null;
  try {
    database = new Database(`${codexHome}/state_5.sqlite`, { readonly: true });
    const rows = database
      .query<StateChatRow, [number]>(
        `SELECT threads.id, threads.name, threads.preview, threads.cwd,
                thread_sections.name AS section_name,
                (SELECT projects.name
                   FROM project_roots
                   JOIN projects ON projects.id = project_roots.project_id
                  WHERE threads.cwd = project_roots.path
                     OR threads.cwd LIKE project_roots.path || '/%'
                  ORDER BY length(project_roots.path) DESC
                  LIMIT 1) AS project_name
           FROM threads
           LEFT JOIN thread_sections ON thread_sections.id = threads.thread_section_id
          WHERE threads.archived = 0
            AND threads.source = 'vscode'
          ORDER BY threads.updated_at DESC
          LIMIT ?`,
      )
      .all(RECENT_CHAT_LIST_SIZE);
    const chatList: VoiceChatChoice[] = [];
    for (const row of rows) {
      const label = (row.name ?? row.preview ?? '').replace(/\s+/g, ' ').trim();
      if (label.length === 0) continue;
      chatList.push({
        id: row.id,
        name: label.slice(0, 60),
        folder: folderLabel(row.section_name, row.project_name, row.cwd),
      });
    }
    return chatList;
  } catch {
    // The app-server remains the supported source if Codex changes its local
    // database layout or the file is temporarily unavailable.
    return [];
  } finally {
    database?.close();
  }
}

function setStateDatabasePreviewIfEmpty(threadId: string, preview: string): boolean {
  const label = preview.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (label.length === 0) return false;
  const codexHome = process.env.CODEX_HOME ?? `${homedir()}/.codex`;
  let database: Database | null = null;
  try {
    database = new Database(`${codexHome}/state_5.sqlite`);
    const row = database
      .query(`SELECT preview FROM threads WHERE id = ?`)
      .get(threadId) as { preview?: string | null } | null;
    if (row === null) return false;
    if (
      row.preview !== null &&
      row.preview !== undefined &&
      row.preview !== '' &&
      row.preview !== 'Desk voice chat'
    ) {
      return true;
    }
    database
      .query(
        `UPDATE threads
            SET preview = ?
          WHERE id = ?
        AND (preview = '' OR preview = 'Desk voice chat')`,
      )
      .run(label, threadId);
    return true;
  } catch {
    // The app-server remains authoritative; this only makes realtime-only
    // rows visible to the desktop catalog when the local index permits it.
    return false;
  } finally {
    database?.close();
  }
}

async function setStateDatabasePreviewWhenReady(
  threadId: string,
  preview: string,
): Promise<void> {
  // ponytail: bounded retry for the app's async index; if it ever takes
  // longer than 1.9s, replace this with an app-server catalog event.
  for (const delayMilliseconds of [0, 50, 100, 250, 500, 1_000]) {
    if (delayMilliseconds > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMilliseconds));
    }
    if (setStateDatabasePreviewIfEmpty(threadId, preview)) return;
  }
}

export function mergeRecentChatLists(
  ...chatLists: readonly VoiceChatChoice[][]
): VoiceChatChoice[] {
  const merged = new Map<string, VoiceChatChoice>();
  for (const chatList of chatLists) {
    for (const chat of chatList) {
      const existing = merged.get(chat.id);
      if (existing === undefined) {
        merged.set(chat.id, chat);
      } else if (existing.folder === undefined && chat.folder !== undefined) {
        merged.set(chat.id, { ...existing, folder: chat.folder });
      }
    }
  }
  return [...merged.values()].slice(0, RECENT_CHAT_LIST_SIZE);
}

// Throwaway chats are skipped: they are invisible in Codex, so offering them
// on the watch would resume something the user cannot find again.
export function buildRecentChatList(rawResponse: unknown): VoiceChatChoice[] {
  const parsed = threadListResponseSchema.safeParse(rawResponse);
  if (!parsed.success) return [];
  const seenIdSet = new Set<string>();
  const chatList: VoiceChatChoice[] = [];
  for (const thread of parsed.data.data) {
    if (thread.ephemeral === true || seenIdSet.has(thread.id)) continue;
    const label = (thread.name ?? thread.preview ?? '').replace(/\s+/g, ' ').trim();
    if (label.length === 0) continue;
    seenIdSet.add(thread.id);
    chatList.push({
      id: thread.id,
      name: label.slice(0, 60),
      folder: folderLabel(thread.section?.name, undefined, thread.cwd),
    });
    if (chatList.length >= RECENT_CHAT_LIST_SIZE) break;
  }
  return chatList;
}

export function voiceReasoningEffort(device: string | undefined, configured: unknown): string {
  return device ?? process.env.VOICEMODE_CODEX_REASONING_EFFORT ??
    (typeof configured === 'string' && configured.length > 0 ? configured : 'low');
}

export function voiceThreadSettings(model: string | undefined, effort: string, catalog: readonly VoiceModelCatalogEntry[]): { model: string; reasoningEffort: string } {
  const entry = model === undefined
    ? catalog.find(candidate => candidate.isDefault)
    : catalog.find(candidate => candidate.model === model);
  if (!entry) throw new Error(`Cannot verify reasoning for voice model ${model ?? '(unset)'}. Check your Codex model setting.`);
  if (!entry.supportedReasoningEffortList.includes(effort)) {
    throw new Error(`Model ${entry.model} does not support reasoning ${effort}. Supported: ${entry.supportedReasoningEffortList.join(', ')}. Choose a supported level or another model.`);
  }
  return { model: entry.model, reasoningEffort: effort };
}

export function voiceChatUnavailable(error: unknown): boolean {
  return error instanceof Error && /not found|unknown thread|no rollout|does not exist|\bis archived\b/i.test(error.message);
}

export function voiceThreadConfig(settings?: { model: string; reasoningEffort: string }, realtime = true): Record<string, unknown> {
  return {
    ...(realtime ? { 'features.realtime_conversation': true } : {}),
    ...(settings ? { model: settings.model, model_reasoning_effort: settings.reasoningEffort } : {}),
  };
}

export function resolveVoiceModelSelection(
  requestedModel: string | undefined,
  catalog: readonly VoiceModelCatalogEntry[],
): VoiceModelResolution {
  if (requestedModel === undefined) return { kind: 'absent' };
  const entry = catalog.find((candidate) => candidate.model === requestedModel) ??
    (requestedModel === 'gpt-5.6-luna'
      ? catalog.find((candidate) => candidate.model === 'gpt-6-luna')
      : undefined);
  if (entry === undefined) {
    return {
      kind: 'unknown',
      requestedModel,
      knownModelList: catalog.map((candidate) => candidate.model),
    };
  }
  return {
    kind: 'resolved',
    entry,
  };
}

type PendingCodexRequest = {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

class CodexAppServerTimeoutError extends Error {
  constructor(method: string) {
    super(`Codex app-server ${method} timed out.`);
    this.name = 'CodexAppServerTimeoutError';
  }
}

// Keep device messages short and actionable without forwarding private error data.
export function describeRealtimeFailure(message: string): string {
  return classifyVoiceFailure(message).message;
}

type DesktopIpcRecord = Record<string, unknown>;
type DesktopConversationStateProvider = () => Promise<DesktopIpcRecord>;

function desktopIpcRecord(value: unknown): DesktopIpcRecord | null {
  return typeof value === 'object' && value !== null
    ? (value as DesktopIpcRecord)
    : null;
}

function desktopIpcString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Only a matching reply to the outstanding question may unblock a tool. */
export function voiceRequestResponse(method: string, params: DesktopIpcRecord, requestMethod: string): unknown {
  const matches: Record<string, string> = {
    'thread-follower-command-approval-decision': 'item/commandExecution/requestApproval',
    'thread-follower-file-approval-decision': 'item/fileChange/requestApproval',
    'thread-follower-permissions-request-approval-response': 'item/permissions/requestApproval',
    'thread-follower-submit-user-input': 'item/tool/requestUserInput',
    'thread-follower-submit-mcp-server-elicitation-response': 'mcpServer/elicitation/request',
  };
  if (matches[method] !== requestMethod) throw new Error('This reply does not match the pending Codex request.');
  if (method.endsWith('approval-decision')) {
    const decision = z.union([z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
      z.object({ acceptWithExecpolicyAmendment: z.record(z.unknown()) }).strict(),
      z.object({ applyNetworkPolicyAmendment: z.record(z.unknown()) }).strict()]).parse(params.decision);
    return { decision };
  }
  if (method === 'thread-follower-submit-user-input') {
    return z.object({ answers: z.record(z.object({ answers: z.array(z.string()) })) }).parse(params.response);
  }
  if (method === 'thread-follower-submit-mcp-server-elicitation-response') {
    return z.object({ action: z.enum(['accept', 'decline', 'cancel']),
      content: z.record(z.unknown()).nullable().optional(), _meta: z.record(z.unknown()).nullable().optional(),
    }).parse(params.response);
  }
  return z.object({ permissions: z.record(z.unknown()), scope: z.enum(['turn', 'session']) }).parse(params.response);
}

export function desktopConversationDates(thread: DesktopIpcRecord, nowMs = Date.now()) {
  // The saved chat uses seconds; the desktop's live chat view uses milliseconds.
  const milliseconds = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value * 1_000 : fallback;
  const createdAt = milliseconds(thread.createdAt, nowMs);
  const updatedAt = milliseconds(thread.updatedAt, createdAt);
  return { createdAt, updatedAt, recencyAt: milliseconds(thread.recencyAt, updatedAt) };
}

export function desktopVoiceTurns(
  entries: readonly DesktopIpcRecord[],
  params: DesktopIpcRecord,
  liveSegments: readonly DesktopIpcRecord[] = [],
): DesktopIpcRecord[] {
  // Desktop versions without the new voice timeline read ordinary chat turns.
  // These are display records only; never send them to turn/start.
  const saved = entries.map((entry) => desktopIpcRecord(entry.item));
  const savedSpeech = new Set(
    saved
      .filter((item) => item?.type === 'transcriptSegment')
      .map((item) => `${String(item?.role)}\n${String(item?.text)}`),
  );
  // Once a spoken line lands in the saved timeline its live copy is dropped, so
  // the same words are never shown twice and never blink out in between.
  const spoken = [
    ...saved,
    ...liveSegments.filter((item) => !savedSpeech.has(`${String(item.role)}\n${String(item.text)}`)),
  ];
  return spoken.flatMap((item) => {
    if (item?.type !== 'transcriptSegment' || typeof item.text !== 'string' ||
        item.text.trim().length === 0 ||
        (item.role !== 'user' && item.role !== 'assistant')) return [];
    return [desktopVoiceTurn(item, params)];
  });
}

function desktopVoiceTurn(item: DesktopIpcRecord, params: DesktopIpcRecord): DesktopIpcRecord {
  const text = item.text as string;
  const fromUser = item.role === 'user';
  return {
    // The desktop reads text_elements directly when a spoken message arrives.
    params: {
      ...params,
      input: fromUser ? [{ type: 'text', text, text_elements: [] }] : [],
    },
    turnId: null,
    turnStartedAtMs: null,
    durationMs: null,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    status: 'completed', error: null, diff: null,
    // A spoken line needs a display item of its own. Putting the words only in
    // the turn's input left the user's own lines invisible while the replies
    // showed, because the chat view draws a finished turn from these items.
    items: [fromUser
      ? {
        id: item.id, type: 'userMessage', clientId: null,
        content: [{ type: 'text', text, text_elements: [] }],
      }
      : { id: item.id, type: 'agentMessage', text, phase: 'final' }],
  };
}

function debugConversationBridge(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  // #region debug log
  void fetch('http://127.0.0.1:52761/ingest/8589da', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: '8589da',
      runId: 'before-fix',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

/**
 * Keeps the desktop app's read-only conversation view in sync with the
 * separate app-server used by the voice bridge.
 *
 * This is a private desktop capability, so it is deliberately best effort:
 * voice still works when the app is closed or its IPC protocol changes.
 */
export class DesktopConversationBridge {
  readonly #socketPath: string;
  readonly #threads = new Map<
    string,
    {
      readonly provider: DesktopConversationStateProvider;
      readonly respond?: (method: string, params: DesktopIpcRecord) => void;
      readonly followerClientIdSet: Set<string>;
      revision: number;
    }
  >();
  #socket: Socket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #frameBuffer = Buffer.alloc(0);
  #sourceClientId = `esp32-voice-mode-${process.pid}`;
  #initializeRequestId: string | null = null;
  #connected = false;
  #closed = false;

  constructor(socketPath?: string) {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.#socketPath = socketPath ?? join(codexHome, 'ipc', 'ipc.sock');
  }

  start(): void {
    this.#closed = false;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#connected = false;
  }

  registerThread(threadId: string, provider: DesktopConversationStateProvider,
    respond?: (method: string, params: DesktopIpcRecord) => void): void {
    const existing = this.#threads.get(threadId);
    this.#threads.set(threadId, {
      provider,
      respond,
      followerClientIdSet: existing?.followerClientIdSet ?? new Set(),
      revision: existing?.revision ?? 0,
    });
    this.invalidate();
  }

  publish(threadId: string): void {
    void this.#publishRevision(threadId).catch(() => undefined);
  }

  /**
   * Send one conversation snapshot and report the stream revision it carried.
   *
   * The desktop opens a chat by asking its owner to load the history and then
   * waiting for the owner to publish a revision at least that new. Answering
   * that request needs the revision back, so publishing cannot stay fire and
   * forget.
   */
  async #publishRevision(threadId: string): Promise<number | null> {
    const thread = this.#threads.get(threadId);
    if (thread === undefined || !this.#connected || thread.followerClientIdSet.size === 0) {
      return null;
    }
    const publishStartedAt = Date.now();
    debugConversationBridge('H2', 'DesktopConversationBridge.publish', 'snapshot requested', {
      threadId,
      followerCount: thread.followerClientIdSet.size,
    });
    const conversationState = await thread.provider().catch(() => null);
    if (conversationState === null) return null;
    if (!this.#connected || this.#threads.get(threadId) !== thread) return null;
    debugConversationBridge('H1,H2,H3', 'DesktopConversationBridge.publish', 'snapshot ready', {
      threadId,
      durationMs: Date.now() - publishStartedAt,
    });
    thread.revision += 1;
    this.#sendBroadcast(
      'thread-stream-state-changed',
      {
        hostId: 'local',
        conversationId: threadId,
        change: {
          type: 'snapshot',
          revision: thread.revision,
          conversationState,
        },
      },
      [...thread.followerClientIdSet],
      11,
    );
    return thread.revision;
  }

  invalidate(threadId?: string): void {
    debugConversationBridge('H6', 'DesktopConversationBridge.invalidate', 'asked the desktop to refresh', {
      connected: this.#connected,
    });
    if (!this.#connected) return;
    if (threadId !== undefined && this.#threads.has(threadId)) {
      // Refresh this saved chat in the desktop's live list. Clearing the
      // sidebar's cached query alone never loads a newly created chat.
      // This notification does not change the chat's saved archive status.
      this.#sendBroadcast('thread-unarchived', { hostId: 'local', conversationId: threadId }, [], 1);
      console.log(`Desktop sidebar refresh requested for chat ${threadId}.`);
    }
    // Recents is held under three keys and each window mounts a different one:
    // the main window mounts `recent-conversations-meta`, the extension side
    // panel and the workspace picker mount `recent-conversations`, and `tasks`
    // is the cloud task list. TanStack matches a key by prefix, so naming the
    // bare key covers its `[..., sortKey, hostIds, scope]` variants; naming the
    // wrong one refreshes nothing. `thread-archived` refreshes `tasks` and
    // `archived-threads` on its own, so all three are sent here.
    this.#sendBroadcast('query-cache-invalidate', { queryKey: ['recent-conversations-meta'] }, [], 0);
    this.#sendBroadcast('query-cache-invalidate', { queryKey: ['recent-conversations'] }, [], 0);
    this.#sendBroadcast('query-cache-invalidate', { queryKey: ['tasks'] }, [], 0);
  }

  #connect(): void {
    if (this.#closed || this.#socket !== null) return;
    const socket = createConnection(this.#socketPath);
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      const requestId = randomUUID();
      this.#initializeRequestId = requestId;
      this.#send({
        type: 'request',
        requestId,
        sourceClientId: this.#sourceClientId,
        method: 'initialize',
        params: { clientType: 'esp32_voice_mode' },
        timeoutMs: 10_000,
      });
    });
    socket.on('data', (chunk: Buffer) => this.#readFrames(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#connected = false;
      this.#initializeRequestId = null;
      this.#frameBuffer = Buffer.alloc(0);
      for (const thread of this.#threads.values()) thread.followerClientIdSet.clear();
      if (!this.#closed && this.#reconnectTimer === null) {
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = null;
          this.#connect();
        }, 5_000);
      }
    });
  }

  #readFrames(chunk: Buffer): void {
    this.#frameBuffer = Buffer.concat([this.#frameBuffer, chunk]);
    while (this.#frameBuffer.length >= 4) {
      const length = this.#frameBuffer.readUInt32LE(0);
      if (length <= 0 || length > 32 * 1024 * 1024) {
        this.#socket?.destroy();
        return;
      }
      if (this.#frameBuffer.length < length + 4) return;
      const body = this.#frameBuffer.subarray(4, length + 4).toString('utf8');
      this.#frameBuffer = this.#frameBuffer.subarray(length + 4);
      try {
        this.#handleMessage(JSON.parse(body) as unknown);
      } catch {
        // One malformed private-IPC frame must not take down voice.
      }
    }
  }

  #handleMessage(value: unknown): void {
    const message = desktopIpcRecord(value);
    if (message === null) return;
    if (
      message.type === 'response' &&
      message.requestId === this.#initializeRequestId
    ) {
      const result = desktopIpcRecord(message.result);
      const assignedClientId = desktopIpcString(result?.clientId);
      if (assignedClientId !== null) this.#sourceClientId = assignedClientId;
      this.#initializeRequestId = null;
      this.#connected = message.resultType === 'success';
      if (this.#connected) this.invalidate();
      return;
    }
    if (message.type === 'client-discovery-request') {
      this.#answerDiscovery(message);
      return;
    }
    if (message.type === 'request') {
      const method = desktopIpcString(message.method);
      if (method === 'thread-owner-discovery') {
        this.#answerOwnerDiscovery(message);
      } else if (method !== null && method.startsWith('thread-follower-')) {
        this.#answerFollowerRequest(method, message);
      }
      return;
    }
    if (message.type !== 'broadcast') return;
    const params = desktopIpcRecord(message.params);
    const threadId = desktopIpcString(params?.conversationId);
    if (threadId === null || !this.#threads.has(threadId)) return;
    if (message.method === 'thread-stream-following-changed') {
      const followerClientId = desktopIpcString(message.sourceClientId);
      if (followerClientId !== null) {
        const thread = this.#threads.get(threadId);
        if (thread !== undefined) {
          debugConversationBridge('H4', 'DesktopConversationBridge.following-changed', 'follower state changed', {
            threadId,
            following: params?.following === true,
          });
          if (params?.following === true) {
            thread.followerClientIdSet.add(followerClientId);
            this.publish(threadId);
          } else {
            thread.followerClientIdSet.delete(followerClientId);
          }
        }
      }
      return;
    }
    if (message.method === 'thread-stream-following-status-requested') {
      const requester = desktopIpcString(message.sourceClientId);
      if (requester !== null) {
        const thread = this.#threads.get(threadId);
        debugConversationBridge('H4', 'DesktopConversationBridge.following-status-requested', 'follower requested state', {
          threadId,
        });
        thread?.followerClientIdSet.add(requester);
        this.#sendBroadcast(
          'thread-stream-following-changed',
          { hostId: 'local', conversationId: threadId, following: true },
          [requester],
          1,
        );
        this.publish(threadId);
      }
    }
  }

  #answerDiscovery(message: DesktopIpcRecord): void {
    const request = desktopIpcRecord(message.request);
    const params = desktopIpcRecord(request?.params);
    const threadId = desktopIpcString(params?.conversationId);
    this.#send({
      type: 'client-discovery-response',
      requestId: message.requestId,
      // A follower request is addressed to whoever owns the chat, and this
      // bridge is that owner for every voice chat it created. Claiming the
      // request is what gets it delivered here instead of timing out in the
      // router with nobody answering.
      response: {
        canHandle: threadId !== null && this.#threads.has(threadId) &&
          (request?.method === 'thread-owner-discovery' ||
            (typeof request?.method === 'string' &&
              request.method.startsWith('thread-follower-'))),
      },
    });
  }

  #answerOwnerDiscovery(message: DesktopIpcRecord): void {
    const params = desktopIpcRecord(message.params);
    const threadId = desktopIpcString(params?.conversationId);
    if (threadId === null || !this.#threads.has(threadId)) {
      this.#send({
        type: 'response',
        requestId: message.requestId,
        resultType: 'error',
        error: 'no-client-found',
      });
      return;
    }
    this.#send({
      type: 'response',
      requestId: message.requestId,
      resultType: 'success',
      method: 'thread-owner-discovery',
      handledByClientId: this.#sourceClientId,
      result: { supportsUntrustedAppInput: true },
    });
  }

  /**
   * Answer a follower request about one of our chats.
   *
   * The desktop opens a chat by asking its owner to load the complete history
   * and then waits for the revision that request returns. Staying quiet does
   * not fail fast: the desktop keeps the chat on a spinner and keeps asking.
   * So every request gets an answer - the new revision when we can produce one,
   * and a plain refusal for the ones only a live turn on the device could
   * satisfy.
   */
  #answerFollowerRequest(method: string, message: DesktopIpcRecord): void {
    const params = desktopIpcRecord(message.params);
    const threadId = desktopIpcString(params?.conversationId);
    const thread = threadId === null ? undefined : this.#threads.get(threadId);
    debugConversationBridge('H5', 'DesktopConversationBridge.#answerFollowerRequest', 'follower request received', {
      method,
      threadId,
      owned: thread !== undefined,
    });
    if (threadId === null || thread === undefined) {
      this.#send({
        type: 'response',
        requestId: message.requestId,
        resultType: 'error',
        error: 'no-client-found',
      });
      return;
    }
    if (method !== 'thread-follower-load-complete-history') {
      try {
        if (!thread.respond || !params) throw new Error(`not-supported-by-voice-bridge: ${method}`);
        thread.respond(method, params);
        this.publish(threadId);
        this.#send({ type: 'response', requestId: message.requestId, method,
          resultType: 'success', handledByClientId: this.#sourceClientId, result: {} });
      } catch (error) {
        this.#send({ type: 'response', requestId: message.requestId, resultType: 'error',
          error: error instanceof Error ? error.message : 'Invalid Codex reply' });
      }
      return;
    }
    const requesterClientId = desktopIpcString(message.sourceClientId);
    if (requesterClientId !== null) thread.followerClientIdSet.add(requesterClientId);
    void this.#publishRevision(threadId).then((revision) => {
      debugConversationBridge(
        'H5',
        'DesktopConversationBridge.follower-load-complete-history',
        'history request answered',
        { threadId, revision },
      );
      this.#send(
        revision === null
          ? {
              type: 'response',
              requestId: message.requestId,
              resultType: 'error',
              error: 'no-client-found: thread stream owner became unavailable',
            }
          : {
              type: 'response',
              requestId: message.requestId,
              resultType: 'success',
              method,
              handledByClientId: this.#sourceClientId,
              result: { revision },
            },
      );
    });
  }

  #sendBroadcast(
    method: string,
    params: DesktopIpcRecord,
    targetClientIds: string[],
    version: number,
  ): void {
    this.#send({
      type: 'broadcast',
      method,
      sourceClientId: this.#sourceClientId,
      ...(targetClientIds.length > 0 ? { targetClientIds } : {}),
      version,
      params,
    });
  }

  #send(message: DesktopIpcRecord): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    try {
      socket.write(frame);
    } catch {
      socket.destroy();
    }
  }
}

export type ActiveRealtimeSession = {
  readonly requestId: string;
  readonly onError: (message: string) => void;
  readonly onTranscript: (
    message: Extract<
      CodexBridgeMessage,
      { type: 'realtime_transcript_delta' | 'realtime_transcript_done' | 'realtime_status' }
    >,
  ) => void;
  threadId: string | null;
  readonly ephemeral: boolean;
  // True once the call actually came up, which here means a realtime activity
  // arrived on the device's screen. False therefore means the device dialled
  // and never got a usable session.
  liveSessionSeen: boolean;
  // A fresh voice chat has no title in Codex until we set one, so the first
  // thing the user says becomes the name. Resumed chats keep their name.
  needsName: boolean;
  // Speech that has not finished yet, per speaker. The saved timeline only
  // holds finished segments, so an open chat needs these to show words while
  // they are still being spoken.
  liveSpeech: { user: string; assistant: string };
  answer: {
    readonly resolve: (sdp: string) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  } | null;
};


export class CodexAppServerClient {
  readonly #serverRequests = new Map<string, { id: string | number; method: string; params: DesktopIpcRecord }>();
  readonly #markedCallStartedThreadIdSet = new Set<string>();
  readonly #process: DesktopCodexProcess;
  readonly #readlineInterface: Interface;
  readonly #pendingRequestMap = new Map<number, PendingCodexRequest>();
  #nextRequestId = 1;
  #activeRealtimeSession: ActiveRealtimeSession | null = null;
  // One timer for the whole call: the desktop is told the chat changed at a
  // readable pace instead of once per spoken word.
  #liveSpeechPublishTimer: ReturnType<typeof setTimeout> | null = null;
  // The attempt that failed before its call ever came up, kept so the device's
  // redial can continue the chat it opened instead of adding another empty
  // "Desk voice chat" to the sidebar.
  #lastFailedSession: ActiveRealtimeSession | null = null;
  // Chats already given their opening turn, so a redial into the same chat does
  // not write a second one.
  #voiceModelCatalog: VoiceModelCatalogEntry[] | null = null;
  #voiceModelCatalogPromise: Promise<VoiceModelCatalogEntry[] | null> | null = null;
  #voiceModelCatalogRetryAfterMilliseconds = 0;
  #recentChatList: VoiceChatChoice[] = [];
  #recentChatListPromise: Promise<VoiceChatChoice[]> | null = null;
  #recentChatListRefreshAfterMilliseconds = 0;
  #activityGeneration = 0;
  readonly #connectorMetadataCache: ConnectorMetadataCache;
  readonly #desktopConversationBridge = new DesktopConversationBridge();

  constructor(readonly workingDirectory: string) {
    this.#process = new DesktopCodexProcess(workingDirectory, buildCodexOverrides());
    this.#readlineInterface = createInterface({ input: this.#process.stdout });
    this.#readlineInterface.on('line', (line) => this.#handleLine(line));
    this.#process.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.#connectorMetadataCache = new ConnectorMetadataCache(
      (connectorId, timeoutMilliseconds) =>
        this.#request('app/read', { appIds: [connectorId], includeTools: false }, timeoutMilliseconds),
    );
    this.#process.on('exit', (code) => {
      const error = new Error(`Codex app-server stopped${code === null ? '' : ` (${code})`}.`);
      for (const pendingRequest of this.#pendingRequestMap.values()) {
        clearTimeout(pendingRequest.timeout);
        pendingRequest.reject(error);
      }
      this.#pendingRequestMap.clear();
      this.#failRealtimeSession(error);
      if (!this.#process.killed) {
        // launchd can restart this only after the process exits. If Codex
        // dies underneath us, staying up would leave a listener that looks
        // alive and cannot answer a call.
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      }
    });
  }

  async start(): Promise<void> {
    this.#desktopConversationBridge.start();
    await this.#request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: 'esp32_voice_mode',
        title: 'ESP32 Voice Mode',
        version: CLIENT_VERSION,
      },
    });
    this.#send({ method: 'initialized', params: {} });
    const storageRoot = this.workingDirectory;
    try {
      mkdirSync(storageRoot, { recursive: true });
      // Ask the child itself: the listener may have access that Codex lacks.
      await this.#request('config/read', { cwd: storageRoot, includeLayers: false });
    } catch (error) {
      throw voiceStorageError(storageRoot, error);
    }
    console.log(`Voice chat folder verified by Codex: ${storageRoot}`);
    console.log(`Codex is ready in ${this.workingDirectory}`);
    void this.#refreshRealtimePickerData();
  }

  async startRealtimeSession(
    request: Extract<CodexBridgeRealtimeRequest, { type: 'realtime_offer' }>,
    onError: (message: string) => void,
    onTranscript: ActiveRealtimeSession['onTranscript'],
  ): Promise<{
    readonly sdp: string;
    readonly models: readonly VoiceModelChoice[];
    readonly selectedModel: string | null;
    readonly threadId: string;
    readonly chats: readonly VoiceChatChoice[];
  }> {
    const previousSession = this.#activeRealtimeSession;
    const setupStartedAt = Date.now();
    const activeSession: ActiveRealtimeSession = {
      requestId: request.requestId,
      threadId: null,
      ephemeral: request.temporary === true,
      liveSessionSeen: false,
      needsName: false,
      liveSpeech: { user: '', assistant: '' },
      onError,
      onTranscript,
      answer: null,
    };
    const answerPromise = new Promise<string>((resolve, reject) => {
      activeSession.answer = {
        resolve,
        reject,
        timeout: setTimeout(
          () =>
            this.#failRealtimeSession(
              new CodexAppServerTimeoutError('thread/realtime/sdp'),
              activeSession,
            ),
          CODEX_APP_SERVER_REALTIME_TIMEOUT_MILLISECONDS,
        ),
      };
    });
    // A stop can arrive while thread/start is still pending. Attach the
    // rejection handler now, before the setup flow reaches Promise.all.
    void answerPromise.catch(() => undefined);
    this.#activeRealtimeSession = activeSession;

    if (previousSession !== null && previousSession.answer !== null) {
      clearTimeout(previousSession.answer.timeout);
      previousSession.answer.reject(new Error('ChatGPT Voice session replaced.'));
    }

    try {
      // A call that failed before it came up leaves no session behind, so the
      // chat it opened is remembered separately; this offer may be the device
      // dialling again into it.
      const reuseCandidate = previousSession ?? this.#lastFailedSession;
      this.#lastFailedSession = null;
      let reusedThreadId = decideThreadReuse({
        previousThreadId: reuseCandidate?.threadId ?? null,
        previousCallCameUp: reuseCandidate?.liveSessionSeen === true,
        requestedThreadId: request.threadId,
      });
      if (reusedThreadId === null && previousSession !== null && previousSession.threadId !== null) {
        await this.#releaseThread(previousSession.threadId);
      }
      // Reject unknown choices before opening a new thread.
      const modelSelection = await this.#resolveRealtimeModelSelection(request.model);
      console.log(`Voice setup ${Date.now() - setupStartedAt} ms: model list done.`);
      if (modelSelection.resolution.kind === 'unknown') {
        throw new Error(
          `Unknown voice model: ${request.model}. Available: ${
            modelSelection.resolution.knownModelList.join(', ') || '(none)'
          }`,
        );
      }
      if (modelSelection.resolution.kind === 'catalog_unavailable') {
        throw new Error(
          `Voice model catalog unavailable; refusing explicit model "${request.model}".`,
        );
      }
      if (this.#activeRealtimeSession !== activeSession) {
        throw new Error('ChatGPT Voice session stopped during setup.');
      }
      const settings = desktopIpcRecord(await this.#request('config/read', {
        cwd: this.workingDirectory, includeLayers: false,
      }));
      const configured = desktopIpcRecord(settings?.config);
      const modelOverrides = voiceThreadSettings(
        modelSelection.resolution.kind === 'resolved'
          ? modelSelection.resolution.entry.model
          : desktopIpcString(configured?.model) ?? undefined,
        voiceReasoningEffort(request.reasoningEffort, configured?.model_reasoning_effort),
        modelSelection.catalog ?? await this.#fetchVoiceModelCatalog() ?? [],
      );
      if (reusedThreadId !== null) {
        // Releasing a failed call unloads its chat. Reopen it before retrying;
        // if it is gone, let the normal fresh-chat path take over.
        if (await this.#resumeThread(reusedThreadId, modelOverrides) === null) {
          console.log(`Previous voice chat ${reusedThreadId} is unavailable; opening a new chat.`);
          reusedThreadId = null;
        } else {
          console.log(`Repeating offer: reusing chat ${reusedThreadId} from an attempt that never connected.`);
          await this.#request('thread/realtime/stop', { threadId: reusedThreadId })
            .catch(() => undefined);
        }
      }
      // Resume the requested chat when the device names one; otherwise open a
      // new chat. Only an explicit `temporary` flag keeps it out of Codex.
      const resumedThreadId =
        request.threadId !== undefined && request.temporary !== true
          ? await this.#resumeThread(request.threadId, modelOverrides)
          : null;
      const threadId =
        reusedThreadId ??
        resumedThreadId ??
        (await this.#startEphemeralThread(
          true,
          modelOverrides,
          request.temporary === true,
        ));
      if (this.#activeRealtimeSession !== activeSession) {
        throw new Error('ChatGPT Voice session stopped during setup.');
      }
      activeSession.threadId = threadId;
      console.log(`Voice setup ${Date.now() - setupStartedAt} ms: chat ready.`);
      if (activeSession.ephemeral) {
        // The watch asked for a temporary chat. Saying so here is what makes a
        // call that is meant to leave nothing behind distinguishable, in the log,
        // from one the sidebar simply failed to show.
        console.log('This call is a temporary chat: it will not appear in Codex.');
      }
      activeSession.needsName = reusedThreadId === null
        ? resumedThreadId === null && request.temporary !== true
        : reuseCandidate?.needsName === true;
      // Codex lists a chat after it holds a user turn. Keep the startup marker
      // so a fresh voice chat has a record the app can reopen.
      if (
        !activeSession.ephemeral &&
        resumedThreadId === null &&
        !this.#markedCallStartedThreadIdSet.has(threadId)
      ) {
        this.#markedCallStartedThreadIdSet.add(threadId);
        this.#markCallStarted(activeSession, threadId);
      }
      // A reused chat is still waiting for a name if the attempt that opened it
      // never got as far as hearing anything, so keep that intent rather than
      // leaving it as the "Desk voice chat" placeholder forever.
      if (activeSession.needsName) {
        // Codex titles a thread from its first turn, and a voice call's first
        // turn is an internal handoff message — that XML would become the
        // sidebar title. Claim a readable placeholder now; the first thing the
        // user says replaces it.
        void this.#request('thread/name/set', {
          threadId,
          name: buildDeskCallTitle(null),
        }).then(() => {
          this.#desktopConversationBridge.invalidate(threadId);
          this.#desktopConversationBridge.publish(threadId);
        }).catch(() => undefined);
      }
      // Log the voice actually used, so a call in the wrong voice can be
      // traced to the request rather than diagnosed by ear.
      const realtimeVoice = resolveRealtimeVoice(request.voice);
      console.log(
        `Voice call using "${realtimeVoice}" (device asked for ${
          request.voice === undefined ? 'nothing' : `"${request.voice}"`
        }).`,
      );
      const [, answerSdp] = await Promise.all([
        this.#request('thread/realtime/start', {
          threadId,
          transport: { type: 'webrtc', sdp: request.sdp },
          version: 'v3',
          voice: realtimeVoice,
          outputModality: 'audio',
          includeStartupContext: true,
          clientManagedHandoffs: false,
          codexResponsesAsItems: true,
          // When this was true, hanging up posted a visible message into the
          // chat: "The user just ended their realtime session. Here is the
          // remaining handoff/transcript tail..." followed by the assistant
          // dutifully replying "Got it - the realtime session ended." That is
          // what this flag does. It takes whatever speech has not already been
          // handed to the text agent and sends it as one more user turn after
          // the call, purely so the agent can react to a trailing request.
          // Nothing about saving the conversation depends on it: every spoken
          // turn is already written when the speaker finishes it.
          flushTranscriptTailOnSessionEnd: false,
          // Greeting instruction: see README v3 initialItems shape. Needs live
          // voice validation on a real device — the bridge forwards it but
          // nothing here can prove the model speaks it without a mic round-trip.
          //
          // Asking for the greeting at session open makes the assistant's very
          // first response the one that is most likely to arrive as captions
          // with no voice, and a silent first response trips the device's stall
          // check before the user has asked anything. Setting
          // VOICEMODE_GREETING=0 leaves the greeting out, which is how to
          // tell a greeting-only fault apart from a session that never carries
          // voice at all.
          initialItems:
            process.env.VOICEMODE_GREETING === '0'
              ? undefined
              : [
                  {
                    role: 'developer',
                    text: 'When this voice call opens, greet the user once, briefly: "Salaam, what are we tackling today?" Then listen. Do not invent a user question or start tools for the greeting.',
                  },
                ],
        }),
        answerPromise,
      ]);
      console.log(`Voice setup ${Date.now() - setupStartedAt} ms: answer ready.`);
      if (this.#activeRealtimeSession !== activeSession) {
        throw new Error('ChatGPT Voice session stopped during setup.');
      }
      const choiceList =
        modelSelection.resolution.kind === 'resolved' && modelSelection.catalog !== null
          ? buildVoiceModelChoiceList(modelSelection.catalog)
          : modelSelection.choiceList;
      const selectedModel = modelOverrides.model;
      const chatList =
        request.temporary === true ? [] : this.#readRecentChatsWithoutWaiting();
      return {
        sdp: answerSdp,
        models: choiceList,
        selectedModel,
        threadId,
        chats: chatList,
      };
    } catch (error) {
      this.#failRealtimeSession(
        error instanceof Error ? error : new Error(String(error)),
        activeSession,
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async stopRealtimeSession(requestId?: string): Promise<void> {
    const activeSession = this.#activeRealtimeSession;
    if (activeSession === null || (requestId !== undefined && activeSession.requestId !== requestId)) {
      return;
    }
    this.#activeRealtimeSession = null;
    // The device can hang up a call that never came up. Remember the chat it
    // opened so the redial continues it instead of leaving another empty one.
    if (activeSession.threadId !== null && !activeSession.liveSessionSeen) {
      this.#lastFailedSession = activeSession;
    }
    if (activeSession.answer !== null) {
      clearTimeout(activeSession.answer.timeout);
      activeSession.answer.reject(new Error('ChatGPT Voice session stopped.'));
    }
    if (activeSession.threadId === null) {
      return;
    }
    await this.#releaseThread(activeSession.threadId);
  }

  #markCallStarted(session: ActiveRealtimeSession, threadId: string): void {
    void this.#request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Voice call started.' }],
    }).then(async () => {
      if (session.needsName) {
        await this.#request('thread/name/set', { threadId, name: buildDeskCallTitle(null) })
          .catch(() => undefined);
      }
      this.#desktopConversationBridge.invalidate(threadId);
      this.#desktopConversationBridge.publish(threadId);
    }).catch(() => undefined);
  }

  /** Stop voice before dropping the subscription so Codex can release the chat. */
  async #releaseThread(threadId: string): Promise<void> {
    const startedAt = Date.now();
    if (await releaseVoiceChat((method, params) => this.#request(method, params), threadId)) {
      console.log(`Voice chat released: ${threadId} in ${Date.now() - startedAt} ms.`);
      this.#desktopConversationBridge.invalidate(threadId);
      this.#desktopConversationBridge.publish(threadId);
    }
  }

  close(): void {
    this.#desktopConversationBridge.close();
    this.#readlineInterface.close();
    this.#process.kill();
  }

  #send(message: Record<string, unknown>): void {
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method: string, params: unknown,
    timeoutMilliseconds = CODEX_APP_SERVER_REQUEST_TIMEOUT_MILLISECONDS): Promise<unknown> {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pendingRequestMap.delete(id)) {
          return;
        }
        reject(new CodexAppServerTimeoutError(method));
      }, timeoutMilliseconds);
      this.#pendingRequestMap.set(id, { resolve, reject, timeout });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pendingRequestMap.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #handleLine(line: string): void {
    const parsedJson = (() => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })();
    const parsedMessage = codexMessageSchema.safeParse(parsedJson);
    if (!parsedMessage.success) {
      return;
    }
    const message = parsedMessage.data;
    if (message.id !== undefined && message.method === undefined) {
      const requestId = typeof message.id === 'number' ? message.id : Number(message.id);
      const pendingRequest = this.#pendingRequestMap.get(requestId);
      if (pendingRequest === undefined) {
        return;
      }
      this.#pendingRequestMap.delete(requestId);
      clearTimeout(pendingRequest.timeout);
      if (message.error !== undefined) {
        pendingRequest.reject(
          new Error(message.error.message ?? 'Codex request failed.'),
        );
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }
    if (message.method === undefined) {
      return;
    }
    if (message.id !== undefined) {
      this.#answerServerRequest(message.id, message.method, message.params);
      return;
    }
    this.#handleNotification(message.method, message.params);
  }

  #handleNotification(method: string, params: unknown): void {
    if (method === 'serverRequest/resolved') {
      const resolved = desktopIpcRecord(params);
      this.#serverRequests.delete(String(resolved?.requestId));
      const threadId = desktopIpcString(resolved?.threadId);
      if (threadId) this.#desktopConversationBridge.publish(threadId);
    }
    const activity = readRealtimeActivity(method, params);
    const realtimeSession = this.#activeRealtimeSession;
    if (activity !== null && realtimeSession?.threadId === activity.threadId) {
      // The screen is showing something, so this chat did come up: a later
      // offer should open a new chat rather than extend this one.
      realtimeSession.liveSessionSeen = true;
      this.#lastFailedSession = null;
      const generation = ++this.#activityGeneration;
      const isCurrent = () => this.#activeRealtimeSession === realtimeSession &&
        this.#activityGeneration === generation;
      // A new chat's registration turn is not a user request. Keep its
      // Thinking/Answering events off the watch until the first user sentence.
      if (!realtimeSession.needsName) realtimeSession.onTranscript({
        type: 'realtime_status',
        requestId: realtimeSession.requestId,
        caption: activity.caption,
        icon: activity.icon,
      });
      if (!realtimeSession.needsName && activity.connectorId !== undefined) {
        const pixels = this.#connectorMetadataCache.resolve(activity.connectorId).then((metadata) => {
          const url = metadata?.iconUrlDark ?? metadata?.iconUrl;
          return url && isCurrent() ? resolveIconPixels(url) : null;
        });
        void forwardActivityIcon(pixels, isCurrent, (iconPixels) => realtimeSession.onTranscript({
          type: 'realtime_status', requestId: realtimeSession.requestId,
          caption: activity.caption, iconPixels,
        }));
      }
    }
    if (method === 'thread/realtime/sdp') {
      const parsedSdp = realtimeSdpSchema.safeParse(params);
      const activeSession = this.#activeRealtimeSession;
      if (
        parsedSdp.success &&
        activeSession !== null &&
        activeSession.threadId === parsedSdp.data.threadId &&
        activeSession.answer !== null
      ) {
        const answer = activeSession.answer;
        activeSession.answer = null;
        clearTimeout(answer.timeout);
        answer.resolve(parsedSdp.data.sdp);
      }
      return;
    }
    if (method === 'thread/realtime/transcript/delta') {
      const parsedTranscript = realtimeTranscriptDeltaSchema.safeParse(params);
      const activeSession = this.#activeRealtimeSession;
      if (
        parsedTranscript.success &&
        activeSession !== null &&
        activeSession.threadId === parsedTranscript.data.threadId
      ) {
        const speaker = parsedTranscript.data.role;
        if (activeSession.liveSpeech[speaker].length === 0) {
          console.log(`Live speech from the ${speaker} is streaming into the chat.`);
        }
        // Deltas are pieces of one line, so the live line grows the way the
        // app's own voice chat fills in as the speaker talks.
        activeSession.liveSpeech[speaker] += parsedTranscript.data.delta;
        this.#publishLiveSpeechSoon(parsedTranscript.data.threadId);
        activeSession.onTranscript({
          type: 'realtime_transcript_delta',
          requestId: activeSession.requestId,
          role: speaker,
          delta: parsedTranscript.data.delta,
        });
      }
      return;
    }
    if (method === 'thread/realtime/transcript/done') {
      const parsedTranscript = realtimeTranscriptDoneSchema.safeParse(params);
      const activeSession = this.#activeRealtimeSession;
      if (
        parsedTranscript.success &&
        activeSession !== null &&
        activeSession.threadId === parsedTranscript.data.threadId
      ) {
        // The finished line is in the saved timeline by now. Dropping the live
        // copy stops the same words being shown twice.
        activeSession.liveSpeech[parsedTranscript.data.role] = '';
        if (
          activeSession.needsName &&
          parsedTranscript.data.role === 'user' &&
          activeSession.threadId !== null
        ) {
          const chatName = buildChatNameFromSpeech(parsedTranscript.data.text);
          if (chatName !== null) {
            activeSession.needsName = false;
            void this.#request('thread/name/set', {
              threadId: activeSession.threadId,
              name: buildDeskCallTitle(chatName),
            }).then(() => {
              this.#desktopConversationBridge.invalidate(parsedTranscript.data.threadId);
              this.#desktopConversationBridge.publish(parsedTranscript.data.threadId);
            }).catch(() => undefined);
          }
        }
        if (!activeSession.ephemeral && parsedTranscript.data.role === 'user') {
          setStateDatabasePreviewIfEmpty(
            parsedTranscript.data.threadId,
            buildChatNameFromSpeech(parsedTranscript.data.text) ?? parsedTranscript.data.text,
          );
        }
        activeSession.onTranscript({
          type: 'realtime_transcript_done',
          requestId: activeSession.requestId,
          role: parsedTranscript.data.role,
          text: parsedTranscript.data.text,
        });
        this.#desktopConversationBridge.invalidate();
        this.#desktopConversationBridge.publish(parsedTranscript.data.threadId);
      }
      return;
    }
    if (method === 'thread/realtime/error') {
      const parsedError = realtimeErrorSchema.safeParse(params);
      if (
        parsedError.success &&
        this.#activeRealtimeSession?.threadId === parsedError.data.threadId
      ) {
        this.#failRealtimeSession(new Error(parsedError.data.message));
      }
      return;
    }
    if (method === 'thread/realtime/closed') {
      const parsedClosed = realtimeClosedSchema.safeParse(params);
      // "requested" is the echo of a stop this bridge asked for, and only this
      // bridge can ask for one: the device's hang-up goes through the same
      // call. Re-dialling into a chat stops the dead transport on that chat
      // first, and that echo lands after the new attempt has already claimed
      // the chat, which made every redial look like a failed call.
      if (parsedClosed.success && parsedClosed.data.reason === 'requested') {
        return;
      }
      if (
        parsedClosed.success &&
        this.#activeRealtimeSession?.threadId === parsedClosed.data.threadId
      ) {
        this.#failRealtimeSession(
          new Error(
            parsedClosed.data.reason === null
              ? 'ChatGPT Voice closed.'
              : `ChatGPT Voice closed: ${parsedClosed.data.reason}`,
          ),
        );
        this.#desktopConversationBridge.invalidate();
        this.#desktopConversationBridge.publish(parsedClosed.data.threadId);
      }
      return;
    }
  }

  /** Make a new chat under the configured service storage folder. */
  #voiceChatFolder(): string {
    const root = this.workingDirectory;
    try {
      return createVoiceChatFolder(root);
    } catch (error) {
      throw voiceStorageError(root, error);
    }
  }

  async #startEphemeralThread(
    enableRealtime = false,
    modelOverrides?: {
      readonly model: string;
      readonly reasoningEffort: string;
    },
    ephemeral = true,
  ): Promise<string> {
    const scratchFolder = this.#voiceChatFolder();
    const config = voiceThreadConfig(modelOverrides, enableRealtime);
    const threadResult = await this.#request('thread/start', {
      cwd: scratchFolder,
      developerInstructions: buildCodexDeveloperInstructions(),
      ephemeral,
      // Keep the same analytics label as native realtime chats. It does not
      // control the desktop sidebar; the app-server process boundary does.
      threadSource: 'realtime_voice',
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });
    const threadId = z
      .object({ thread: z.object({ id: z.string().min(1) }) })
      .parse(threadResult).thread.id;
    this.#registerThread(threadId, threadResult);
    if (!ephemeral) {
      this.#desktopConversationBridge.invalidate();
      this.#desktopConversationBridge.publish(threadId);
      void setStateDatabasePreviewWhenReady(threadId, 'Desk voice chat').finally(() => {
        this.#desktopConversationBridge.invalidate(threadId);
        this.#desktopConversationBridge.publish(threadId);
      });
    }
    return threadId;
  }

  /** Speech still in progress, shaped like saved transcript segments. */
  #liveSpeechSegments(threadId: string): DesktopIpcRecord[] {
    const session = this.#activeRealtimeSession;
    if (session === null || session.threadId !== threadId) return [];
    return (['user', 'assistant'] as const)
      .filter((role) => session.liveSpeech[role].trim().length > 0)
      .map((role) => ({
        id: `live-${role}`, type: 'transcriptSegment', role, text: session.liveSpeech[role],
      }));
  }

  /**
   * Show speech while it is still being spoken.
   *
   * The desktop redraws an open chat only when it is told the chat changed, and
   * every telling rebuilds the snapshot. One telling per quarter second reads as
   * live text and leaves the call alone.
   */
  #publishLiveSpeechSoon(threadId: string): void {
    if (this.#liveSpeechPublishTimer !== null) return;
    this.#liveSpeechPublishTimer = setTimeout(() => {
      this.#liveSpeechPublishTimer = null;
      this.#desktopConversationBridge.publish(threadId);
    }, 250);
  }

  async #buildConversationState(threadId: string): Promise<DesktopIpcRecord> {
    const buildStartedAt = Date.now();
    debugConversationBridge('H1,H3', 'CodexAppServerClient.#buildConversationState', 'build started', {
      threadId,
    });
    const [rawThreadResult, firstTimelineResult] = await Promise.all([
      this.#request('thread/read', { threadId }).catch(() => undefined),
      this.#request('thread/timeline/list', { threadId, limit: 500 }).catch(() => undefined),
    ]);
    const initialFetchDurationMs = Date.now() - buildStartedAt;
    const rawThreadResponse = desktopIpcRecord(rawThreadResult);
    const thread = desktopIpcRecord(rawThreadResponse?.thread) ?? rawThreadResponse ?? {};
    const timelinePages: DesktopIpcRecord[] = [];
    let timelineResponse = desktopIpcRecord(firstTimelineResult);
    let cursor: string | null = null;
    for (let page = 0; page < 10 && timelineResponse !== null; page += 1) {
      timelinePages.push(timelineResponse);
      const data = Array.isArray(timelineResponse.data) ? timelineResponse.data : [];
      const nextCursor = desktopIpcString(timelineResponse.nextCursor);
      if (nextCursor === null || nextCursor === cursor) break;
      cursor = nextCursor;
      timelineResponse = desktopIpcRecord(
        await this.#request('thread/timeline/list', {
          threadId,
          limit: 500,
          cursor,
        }).catch(() => undefined),
      );
      if (data.length === 0 && timelineResponse === null) break;
    }

    const realtimeEntries = timelinePages
      .flatMap((page) => (Array.isArray(page.data) ? page.data : []))
      .map((entry) => desktopIpcRecord(entry))
      .filter((entry): entry is DesktopIpcRecord =>
        entry?.type === 'realtime' && desktopIpcRecord(entry.item) !== null,
      )
      .map((entry) => {
        const item = desktopIpcRecord(entry.item) as DesktopIpcRecord;
        return { ...entry, item };
      });
    const dates = desktopConversationDates(thread);
    const cwd = desktopIpcString(thread.cwd) ?? this.workingDirectory;
    const settings = this.#threadSettings.get(threadId);
    const model = desktopIpcString(settings?.model) ?? desktopIpcString(thread.latestModel) ??
      process.env.VOICEMODE_CODEX_MODEL ?? null;
    const reasoningEffort = desktopIpcString(settings?.reasoningEffort) ?? desktopIpcString(thread.latestReasoningEffort) ?? null;
    const collaborationMode = desktopIpcRecord(thread.latestCollaborationMode) ?? {
      mode: 'default',
      settings: {
        model: model ?? '',
        reasoning_effort: reasoningEffort,
        developer_instructions: null,
      },
    };
    const isActive = this.#activeRealtimeSession?.threadId === threadId;
    // Words still being spoken. The saved timeline holds only finished
    // segments, so these are what make an open chat fill in as you talk.
    const liveSegments = isActive ? this.#liveSpeechSegments(threadId) : [];

    debugConversationBridge('H1,H2,H3', 'CodexAppServerClient.#buildConversationState', 'build ready', {
      threadId,
      durationMs: Date.now() - buildStartedAt,
      initialFetchDurationMs,
      timelinePageCount: timelinePages.length,
      realtimeEntryCount: realtimeEntries.length,
      active: isActive,
    });

    return {
      id: threadId,
      forkedFromId: thread.forkedFromId ?? null,
      hostId: 'local',
      turns: desktopVoiceTurns(realtimeEntries, {
        threadId, cwd, model, effort: reasoningEffort,
        approvalPolicy: settings?.approvalPolicy ?? null, approvalsReviewer: settings?.approvalsReviewer ?? 'user',
        sandboxPolicy: settings?.sandbox ?? null,
        summary: 'none', personality: null, outputSchema: null, collaborationMode,
      }, liveSegments),
      requests: [...this.#serverRequests.values()].filter((request) => request.params.threadId === threadId)
        .map((request) => ({ ...request, id: String(request.id) })),
      ...dates,
      title: desktopIpcString(thread.name) ?? desktopIpcString(thread.title) ?? 'Desk voice chat',
      originator: desktopIpcString(thread.originator) ?? 'esp32_voice_mode',
      source: desktopIpcString(thread.source) ?? 'vscode',
      agentNickname: thread.agentNickname ?? null,
      threadSource: desktopIpcString(thread.threadSource) ?? 'realtime_voice',
      historyMode: desktopIpcString(thread.historyMode) ?? 'paginated',
      canonicalVoiceHistory: false,
      parentThreadId: thread.parentThreadId ?? null,
      mode: desktopIpcString(thread.mode) ?? 'default',
      threadStartKind: thread.threadStartKind ?? null,
      modelProvider: thread.modelProvider ?? null,
      daybreakEnabled: thread.daybreakEnabled ?? false,
      latestModel: model,
      latestReasoningEffort: reasoningEffort,
      previousTurnModel: thread.previousTurnModel ?? null,
      // Codex builds this object for every chat it opens and reads
      // `latestCollaborationMode.settings` without checking for null, so a null
      // here is what makes opening a voice chat fail with "Cannot read
      // properties of null (reading 'settings')". Always send the full shape.
      latestCollaborationMode: collaborationMode,
      hasUnreadTurn: false,
      threadGoal: thread.threadGoal ?? null,
      threadRuntimeStatus: isActive ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      rolloutPath: thread.rolloutPath ?? thread.path ?? null,
      gitInfo: thread.gitInfo ?? null,
      resumeState: thread.resumeState ?? 'resumed',
      latestTokenUsageInfo: thread.latestTokenUsageInfo ?? null,
      workspaceKind: desktopIpcString(thread.workspaceKind) ?? 'projectless',
      cwd,
      environments: thread.environments ?? [],
      environmentSelectionEvidence: thread.environmentSelectionEvidence ?? null,
      turnsPagination: {
        olderCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: true,
      },
      sessionId: thread.sessionId ?? null,
      workspaceBrowserRoot: thread.workspaceBrowserRoot ?? null,
      projectlessOutputDirectory: thread.projectlessOutputDirectory ?? null,
      shellEnvironmentPolicy: thread.shellEnvironmentPolicy ?? null,
      paginatedHistory: { itemsBackwardsCursor: null },
      currentPermissions: thread.currentPermissions ?? null,
      latestThreadSettings: thread.latestThreadSettings ?? {
        cwd,
        approvalPolicy: settings?.approvalPolicy ?? null,
        approvalsReviewer: settings?.approvalsReviewer ?? 'user',
        activePermissionProfile: settings?.activePermissionProfile ?? null,
        sandboxPolicy: settings?.sandbox ?? null,
        permissions: null,
        model,
        serviceTier: settings?.serviceTier ?? null,
        effort: reasoningEffort,
        multiAgentMode: settings?.multiAgentMode ?? 'explicitRequestOnly',
        collaborationMode: {
          mode: 'default',
          settings: {
            model,
            reasoning_effort: reasoningEffort,
            developer_instructions: null,
          },
        },
      },
      threadGoalResumeConfirmation: null,
      itemTimeline: null,
      realtimeItems: {},
      timeline: [],
      turnEntityKeys: [],
      turnsByKey: {},
      itemsByKey: {},
    };
  }

  // Reopen a chat the user already has in Codex. A deleted or unknown id must
  // not strand the call, so callers fall back to a fresh thread.
  async #resumeThread(
    threadId: string,
    modelOverrides?: {
      readonly model: string;
      readonly reasoningEffort: string;
    },
  ): Promise<string | null> {
    const config = voiceThreadConfig(modelOverrides);
    return this.#request('thread/resume', {
      threadId,
      developerInstructions: buildCodexDeveloperInstructions(),
      config,
    })
      .then(
        (result) => {
          const resumedThreadId = z
            .object({ thread: z.object({ id: z.string().min(1) }) })
            .parse(result).thread.id;
          this.#registerThread(resumedThreadId, result);
          this.#desktopConversationBridge.invalidate(resumedThreadId);
          return resumedThreadId;
        },
      )
      .catch((error: unknown) => {
        if (voiceChatUnavailable(error)) {
          const session = this.#activeRealtimeSession;
          session?.onTranscript({ type: 'realtime_status', requestId: session.requestId,
            caption: 'Chat unavailable; starting a new chat', icon: 'none' });
          return null;
        }
        throw error;
      });
  }

  // Recent non-throwaway chats across Codex, so the watch can pick one from
  // any sidebar folder. A failed list only costs the picker, never the call.
  async #listRecentChats(): Promise<VoiceChatChoice[]> {
    const result = await this.#request(
      'thread/list',
      {
        limit: RECENT_CHAT_LIST_SIZE,
        archived: false,
        sortKey: 'updated_at',
        sourceKinds: ['vscode'],
        // Realtime-only chats have no ordinary preview event. The normal
        // rollout scan drops those rows even though Codex has them in SQLite.
        useStateDbOnly: true,
      },
      VOICE_MODEL_CATALOG_FETCH_TIMEOUT_MILLISECONDS,
    ).catch(() => undefined);
    return mergeRecentChatLists(readStateDatabaseChatList(), buildRecentChatList(result));
  }

  #readRecentChatsWithoutWaiting(): VoiceChatChoice[] {
    void this.#refreshRecentChats();
    return this.#recentChatList;
  }

  async #refreshRecentChats(): Promise<VoiceChatChoice[]> {
    if (Date.now() < this.#recentChatListRefreshAfterMilliseconds) {
      return this.#recentChatList;
    }
    if (this.#recentChatListPromise !== null) return this.#recentChatListPromise;
    this.#recentChatListPromise = this.#listRecentChats()
      .then((chatList) => {
        this.#recentChatList = chatList;
        this.#recentChatListRefreshAfterMilliseconds =
          Date.now() + RECENT_CHAT_CACHE_LIFETIME_MILLISECONDS;
        return chatList;
      })
      .finally(() => {
        this.#recentChatListPromise = null;
      });
    return this.#recentChatListPromise;
  }

  async #refreshRealtimePickerData(): Promise<void> {
    await Promise.all([this.#fetchVoiceModelCatalog(), this.#refreshRecentChats()]);
  }

  // Bounded catalog fetch with a short cooldown on failure. A transient
  // outage should not silently disable discovery for the rest of the bridge's
  // lifetime, so we mark the next allowed attempt instead of caching the miss.
  async #fetchVoiceModelCatalog(): Promise<VoiceModelCatalogEntry[] | null> {
    if (this.#voiceModelCatalog !== null) return this.#voiceModelCatalog;
    const nowMilliseconds = Date.now();
    if (nowMilliseconds < this.#voiceModelCatalogRetryAfterMilliseconds) return null;
    if (this.#voiceModelCatalogPromise !== null) return this.#voiceModelCatalogPromise;
    this.#voiceModelCatalogPromise = this.#loadVoiceModelCatalog();
    return this.#voiceModelCatalogPromise.finally(() => {
      this.#voiceModelCatalogPromise = null;
    });
  }

  async #loadVoiceModelCatalog(): Promise<VoiceModelCatalogEntry[] | null> {
    const rawResponse = await this.#fetchVoiceModelCatalogRaw();
    if (rawResponse === undefined) {
      this.#voiceModelCatalogRetryAfterMilliseconds =
        Date.now() + VOICE_MODEL_CATALOG_FAILURE_COOLDOWN_MILLISECONDS;
      return null;
    }
    const catalog = parseVoiceModelCatalog(rawResponse);
    if (catalog === null) {
      this.#voiceModelCatalogRetryAfterMilliseconds =
        Date.now() + VOICE_MODEL_CATALOG_FAILURE_COOLDOWN_MILLISECONDS;
      return null;
    }
    this.#voiceModelCatalog = catalog;
    return catalog;
  }

  async #fetchVoiceModelCatalogRaw(): Promise<unknown | undefined> {
    return this.#request('model/list', {}, VOICE_MODEL_CATALOG_FETCH_TIMEOUT_MILLISECONDS)
      .catch(() => undefined);
  }

  // Default calls use the warmed catalog without putting discovery on the
  // connection path. An explicit selection still waits so it can be validated.
  async #resolveRealtimeModelSelection(
    requestedModel: string | undefined,
  ): Promise<{
    readonly resolution: VoiceModelResolution;
    readonly choiceList: VoiceModelChoice[];
    readonly catalog: VoiceModelCatalogEntry[] | null;
  }> {
    const catalog =
      requestedModel === undefined
        ? this.#voiceModelCatalog
        : await this.#fetchVoiceModelCatalog();
    if (requestedModel === undefined && catalog === null) {
      void this.#fetchVoiceModelCatalog();
    }
    if (catalog === null) {
      if (requestedModel !== undefined) {
        return {
          resolution: { kind: 'catalog_unavailable', requestedModel },
          choiceList: [],
          catalog: null,
        };
      }
      return { resolution: { kind: 'absent' }, choiceList: [], catalog: null };
    }
    const choiceList = buildVoiceModelChoiceList(catalog);
    if (requestedModel === undefined) {
      return { resolution: { kind: 'absent' }, choiceList, catalog };
    }
    const resolution = resolveVoiceModelSelection(requestedModel, catalog);
    return { resolution, choiceList, catalog };
  }

  #failRealtimeSession(
    error: Error,
    expectedSession?: ActiveRealtimeSession,
  ): void {
    const activeSession = this.#activeRealtimeSession;
    if (
      activeSession === null ||
      (expectedSession !== undefined && activeSession !== expectedSession)
    ) {
      return;
    }
    const threadId = activeSession.threadId;
    this.#activeRealtimeSession = null;
    if (threadId !== null && !activeSession.liveSessionSeen) {
      this.#lastFailedSession = activeSession;
    }
    if (threadId !== null) {
        void this.#releaseThread(threadId).finally(() => {
        this.#desktopConversationBridge.invalidate();
        this.#desktopConversationBridge.publish(threadId);
      });
    }
    if (activeSession.answer !== null) {
      clearTimeout(activeSession.answer.timeout);
      activeSession.answer.reject(error);
      return;
    }
    activeSession.onError(error.message);
  }





  #threadSettings = new Map<string, DesktopIpcRecord>();

  #registerThread(threadId: string, settings?: unknown): void {
    const record = desktopIpcRecord(settings);
    if (record) this.#threadSettings.set(threadId, record);
    this.#desktopConversationBridge.registerThread(threadId, () => this.#buildConversationState(threadId),
      (method, params) => {
        const key = String(params.requestId);
        const request = this.#serverRequests.get(key);
        if (!request || request.params.threadId !== threadId) throw new Error('This Codex request is no longer pending.');
        const result = voiceRequestResponse(method, params, request.method);
        this.#serverRequests.delete(key);
        this.#send({ id: request.id, result });
      });
  }

  #answerServerRequest(id: string | number, method: string, rawParams: unknown): void {
    if (method === 'currentTime/read') {
      this.#send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    const interactiveMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
    const params = desktopIpcRecord(rawParams);
    const threadId = desktopIpcString(params?.threadId) ?? this.#activeRealtimeSession?.threadId;
    if (interactiveMethods.includes(method) && params && threadId) {
      this.#serverRequests.set(String(id), { id, method, params: { ...params, threadId } });
      this.#desktopConversationBridge.publish(threadId);
      const session = this.#activeRealtimeSession;
      if (session?.threadId === threadId) {
        session.onTranscript({ type: 'realtime_status', requestId: session.requestId,
          caption: 'Answer in Codex', icon: 'none' });
        void this.#request('thread/realtime/appendText', { threadId, role: 'developer',
          text: 'A tool is waiting for the person to answer a question or approve an action. Tell them briefly to open this voice chat in Codex on their phone or desktop to answer. Do not claim the action was refused or completed.'
        }).catch(() => undefined);
      }
      return;
    }
    console.error(`Codex bridge does not support server request: ${method}`);
    this.#send({ id, error: { code: -32601, message: `Unsupported Codex server request: ${method}` } });
  }
}
