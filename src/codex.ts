import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';

import { z } from 'zod';

import {
  CLIENT_VERSION,
  type CodexBridgeMessage,
  type CodexBridgeRealtimeRequest,
} from './codex-events';
import { readRealtimeActivity, ConnectorMetadataCache } from './activity';
import { forwardActivityIcon, resolveIconPixels } from './icons';

const CONFIGURED_CODEX_EXECUTABLE =
  '/Applications/ChatGPT.app/Contents/Resources/codex';
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
const RECENT_CHAT_LIST_SIZE = 10;
const CODEX_APP_SERVER_SAFE_OVERRIDES = [
  '-c',
  'mcp_servers.palmier-pro.enabled=false',
  '-c',
  'mcp_servers.paste.enabled=false',
  '-c',
  'model="gpt-5.6-luna"',
  '-c',
  'model_reasoning_effort="low"',
] as const;
const CODEX_DEVELOPER_INSTRUCTION_LIST = [
  'You are the local Codex agent behind the voice device on this desk.',
  'Answer the user directly in clear English. Keep the spoken answer short and conversational; do not use Markdown.',
  'Use the MCP servers and plugins configured on this Mac when they fit the request. Do not claim an action succeeded unless the tool confirms it.',
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
      readonly reasoningEffort: string | null;
    };

const VOICE_MODEL_CATALOG_REASONING_PREFERENCE = ['low'] as const;
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
};

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

const threadListResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().nullable().optional(),
        preview: z.string().nullable().optional(),
        ephemeral: z.boolean().optional(),
      })
      .passthrough(),
  ),
});

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
    chatList.push({ id: thread.id, name: label.slice(0, 60) });
    if (chatList.length >= RECENT_CHAT_LIST_SIZE) break;
  }
  return chatList;
}

export function resolveReasoningEffortForEntry(
  entry: VoiceModelCatalogEntry,
): string | null {
  const effortSet = new Set(entry.supportedReasoningEffortList);
  for (const preferredEffort of VOICE_MODEL_CATALOG_REASONING_PREFERENCE) {
    if (effortSet.has(preferredEffort)) return preferredEffort;
  }
  if (
    entry.defaultReasoningEffort !== null &&
    effortSet.has(entry.defaultReasoningEffort)
  ) {
    return entry.defaultReasoningEffort;
  }
  return entry.supportedReasoningEffortList[0] ?? null;
}

export function resolveVoiceModelSelection(
  requestedModel: string | undefined,
  catalog: readonly VoiceModelCatalogEntry[],
): VoiceModelResolution {
  if (requestedModel === undefined) return { kind: 'absent' };
  const entry = catalog.find((candidate) => candidate.model === requestedModel);
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
    reasoningEffort: resolveReasoningEffortForEntry(entry),
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

// The app-server reports a spent ChatGPT quota as a bare retry/429 string, which
// reaches the desk screen verbatim and reads like a device fault. Name the one
// cause the user can act on; everything else passes through untouched.
export function describeRealtimeFailure(message: string): string {
  return /429|too many requests|rate.?limit|usage limit/i.test(message)
    ? 'ChatGPT usage limit reached. Voice returns when it resets.'
    : message;
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
  // A fresh voice chat has no title in Codex until we set one, so the first
  // thing the user says becomes the name. Resumed chats keep their name.
  needsName: boolean;
  answer: {
    readonly resolve: (sdp: string) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  } | null;
};


export class CodexAppServerClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #readlineInterface: Interface;
  readonly #pendingRequestMap = new Map<number, PendingCodexRequest>();
  #nextRequestId = 1;
  #activeRealtimeSession: ActiveRealtimeSession | null = null;
  #voiceModelCatalog: VoiceModelCatalogEntry[] | null = null;
  #voiceModelCatalogPromise: Promise<VoiceModelCatalogEntry[] | null> | null = null;
  #voiceModelCatalogRetryAfterMilliseconds = 0;
  #recentChatList: VoiceChatChoice[] = [];
  #recentChatListPromise: Promise<VoiceChatChoice[]> | null = null;
  #recentChatListRefreshAfterMilliseconds = 0;
  #activityGeneration = 0;
  readonly #connectorMetadataCache: ConnectorMetadataCache;

  constructor(readonly workingDirectory: string) {
    const codexExecutable =
      process.env.APOLLO_CODEX_BIN ??
      (existsSync(CONFIGURED_CODEX_EXECUTABLE) ? CONFIGURED_CODEX_EXECUTABLE : 'codex');
    const appServerArguments = [
      'app-server',
      '--listen',
      'stdio://',
      ...(process.env.APOLLO_CODEX_USE_USER_MCP === '1'
        ? []
        : CODEX_APP_SERVER_SAFE_OVERRIDES),
    ];
    this.#process = spawn(codexExecutable, appServerArguments, {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    await this.#request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: 'esp32_voice_mode',
        title: 'ESP32 Voice Mode',
        version: CLIENT_VERSION,
      },
    });
    this.#send({ method: 'initialized', params: {} });
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
    const activeSession: ActiveRealtimeSession = {
      requestId: request.requestId,
      threadId: null,
      needsName: false,
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
      if (previousSession !== null && previousSession.threadId !== null) {
        await this.#request('thread/realtime/stop', {
          threadId: previousSession.threadId,
        }).catch(() => undefined);
      }
      // Reject unknown choices before opening a new thread.
      const modelSelection = await this.#resolveRealtimeModelSelection(request.model);
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
      const modelOverrides =
        modelSelection.resolution.kind === 'resolved'
          ? {
              model: modelSelection.resolution.entry.model,
              reasoningEffort: modelSelection.resolution.reasoningEffort,
            }
          : undefined;
      // Resume the requested chat when the device names one; otherwise open a
      // new chat. Only an explicit `temporary` flag keeps it out of Codex.
      const resumedThreadId =
        request.threadId !== undefined && request.temporary !== true
          ? await this.#resumeThread(request.threadId, modelOverrides)
          : null;
      const threadId =
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
      activeSession.needsName = resumedThreadId === null && request.temporary !== true;
      if (activeSession.needsName) {
        // Codex titles a thread from its first turn, and a voice call's first
        // turn is an internal handoff message — that XML would become the
        // sidebar title. Claim a readable placeholder now; the first thing the
        // user says replaces it.
        void this.#request('thread/name/set', {
          threadId,
          name: 'Desk voice chat',
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
          flushTranscriptTailOnSessionEnd: true,
          // Greeting instruction: see README v3 initialItems shape. Needs live
          // voice validation on a real device — the bridge forwards it but
          // nothing here can prove the model speaks it without a mic round-trip.
          //
          // Asking for the greeting at session open makes the assistant's very
          // first response the one that is most likely to arrive as captions
          // with no voice, and a silent first response trips the device's stall
          // check before the user has asked anything. Setting
          // APOLLO_VOICE_GREETING=0 leaves the greeting out, which is how to
          // tell a greeting-only fault apart from a session that never carries
          // voice at all.
          initialItems:
            process.env.APOLLO_VOICE_GREETING === '0'
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
      if (this.#activeRealtimeSession !== activeSession) {
        throw new Error('ChatGPT Voice session stopped during setup.');
      }
      const choiceList =
        modelSelection.resolution.kind === 'resolved' && modelSelection.catalog !== null
          ? buildVoiceModelChoiceList(modelSelection.catalog)
          : modelSelection.choiceList;
      const selectedModel =
        modelSelection.resolution.kind === 'resolved'
          ? modelSelection.resolution.entry.model
          : null;
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
    if (activeSession.answer !== null) {
      clearTimeout(activeSession.answer.timeout);
      activeSession.answer.reject(new Error('ChatGPT Voice session stopped.'));
    }
    if (activeSession.threadId === null) {
      return;
    }
    await this.#request('thread/realtime/stop', {
      threadId: activeSession.threadId,
    }).catch(() => undefined);
  }

  close(): void {
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
      this.#answerServerRequest(message.id, message.method);
      return;
    }
    this.#handleNotification(message.method, message.params);
  }

  #handleNotification(method: string, params: unknown): void {
    const activity = readRealtimeActivity(method, params);
    const realtimeSession = this.#activeRealtimeSession;
    if (activity !== null && realtimeSession?.threadId === activity.threadId) {
      const generation = ++this.#activityGeneration;
      const isCurrent = () => this.#activeRealtimeSession === realtimeSession &&
        this.#activityGeneration === generation;
      realtimeSession.onTranscript({
        type: 'realtime_status',
        requestId: realtimeSession.requestId,
        caption: activity.caption,
        icon: activity.icon,
      });
      if (activity.connectorId !== undefined) {
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
        activeSession.onTranscript({
          type: 'realtime_transcript_delta',
          requestId: activeSession.requestId,
          role: parsedTranscript.data.role,
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
              name: chatName,
            }).catch(() => undefined);
          }
        }
        activeSession.onTranscript({
          type: 'realtime_transcript_done',
          requestId: activeSession.requestId,
          role: parsedTranscript.data.role,
          text: parsedTranscript.data.text,
        });
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
      }
      return;
    }
  }

  async #startEphemeralThread(
    enableRealtime = false,
    modelOverrides?: {
      readonly model: string;
      readonly reasoningEffort: string | null;
    },
    ephemeral = true,
  ): Promise<string> {
    const config: Record<string, unknown> = {};
    if (enableRealtime) {
      config['features.realtime_conversation'] = true;
    }
    if (modelOverrides !== undefined) {
      // Voice selection rides on the backing thread, never on the realtime
      // session itself — `thread/realtime/start` voice/outputModality stay
      // default so the device audio path is untouched.
      config.model = modelOverrides.model;
      if (modelOverrides.reasoningEffort !== null) {
        config.model_reasoning_effort = modelOverrides.reasoningEffort;
      }
    }
    const threadResult = await this.#request('thread/start', {
      cwd: this.workingDirectory,
      developerInstructions: buildCodexDeveloperInstructions(),
      ephemeral,
      threadSource: 'apollo',
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });
    return z
      .object({ thread: z.object({ id: z.string().min(1) }) })
      .parse(threadResult).thread.id;
  }

  // Reopen a chat the user already has in Codex. A deleted or unknown id must
  // not strand the call, so callers fall back to a fresh thread.
  async #resumeThread(
    threadId: string,
    modelOverrides?: {
      readonly model: string;
      readonly reasoningEffort: string | null;
    },
  ): Promise<string | null> {
    const config: Record<string, unknown> = {
      'features.realtime_conversation': true,
    };
    if (modelOverrides !== undefined) {
      config.model = modelOverrides.model;
      if (modelOverrides.reasoningEffort !== null) {
        config.model_reasoning_effort = modelOverrides.reasoningEffort;
      }
    }
    return this.#request('thread/resume', {
      threadId,
      developerInstructions: buildCodexDeveloperInstructions(),
      config,
    })
      .then(
        (result) =>
          z.object({ thread: z.object({ id: z.string().min(1) }) }).parse(result).thread
            .id,
      )
      .catch(() => null);
  }

  // Recent non-throwaway chats for this folder, so the watch can pick one to
  // continue. A failed list only costs the picker, never the call.
  async #listRecentChats(): Promise<VoiceChatChoice[]> {
    const result = await this.#request(
      'thread/list',
      { pageSize: RECENT_CHAT_LIST_SIZE, cwd: this.workingDirectory },
      VOICE_MODEL_CATALOG_FETCH_TIMEOUT_MILLISECONDS,
    ).catch(() => undefined);
    return buildRecentChatList(result);
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
    this.#activeRealtimeSession = null;
    if (activeSession.answer !== null) {
      clearTimeout(activeSession.answer.timeout);
      activeSession.answer.reject(error);
      return;
    }
    activeSession.onError(error.message);
  }





  #answerServerRequest(id: string | number, method: string): void {
    // ponytail: phase 1 declines Codex-side approvals; map these to Apollo's
    // device confirmation flow before allowing risky remote actions.
    const response = (() => {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
        case 'applyPatchApproval':
        case 'execCommandApproval':
          return { decision: 'decline' };
        case 'item/permissions/requestApproval':
          return { permissions: {}, scope: 'turn' };
        case 'item/tool/requestUserInput':
          return { answers: {} };
        case 'mcpServer/elicitation/request':
          return { action: 'decline', content: null, _meta: null };
        case 'currentTime/read':
          return { currentTimeAt: Math.floor(Date.now() / 1000) };
        default:
          console.error(`Codex bridge does not support server request: ${method}`);
          return undefined;
      }
    })();
    if (response === undefined) {
      this.#send({
        id,
        error: { code: -32601, message: `Unsupported Codex server request: ${method}` },
      });
      return;
    }
    this.#send({ id, result: response });
  }
}
