#!/usr/bin/env bun
/**
 * The Mac side of the voice desk.
 *
 * The device dials this Mac on the local network and nothing else. This file
 * takes its WebRTC offer, opens a ChatGPT Voice session on the Codex
 * app-server running here, and hands the answer straight back. Captions,
 * status and errors travel the same way.
 *
 * The spoken audio never passes through this process at all: the answer points
 * the device at the realtime service directly, so this Mac sees signalling and
 * text and no audio packets. That is worth knowing before debugging silence -
 * nothing here can drop, delay or repair the voice.
 *
 * Run it on the Mac that is signed in to Codex:
 *
 *   bun run src/listener.ts --port 8790
 *
 * Then point the device at this Mac, for example
 * `CONFIG_APOLLO_URL="ws://192.168.1.20:8790"` in the firmware's gitignored
 * sdkconfig.defaults.local.
 *
 * The device's speaker is the only proof that downlink audio arrived. This
 * process cannot hear it, and neither can a caption.
 */

import { z } from 'zod';

import { codexBridgeMessageSchema, type CodexBridgeMessage } from './codex-events';
import {
  deviceMcpReplySchema,
  encodeServerToDeviceMessage,
  type DeviceMcpReply,
  type ServerToDeviceMessage,
} from './protocol';
import { CodexAppServerClient, describeRealtimeFailure } from './codex';
import { DeviceToolBridge, handleControlRequest } from './controls';
import { parseDevelopmentVariableMap } from './vars';

const DEFAULT_PORT = 8790;

// Named for the project this was forked from, and kept as-is: the firmware
// dials this exact path, so changing it means reflashing the device.
const DEVICE_PATH_PREFIX = '/agents/apollo/';
// Where Codex finds the device's controls. Loopback only - see the fetch
// handler - because anything that can reach it can turn the device's screen
// off and read what is on it.
const CONTROL_PATH = '/mcp';

const realtimeOfferSchema = z.object({
  type: z.literal('realtime_offer'),
  requestId: z.string().min(1),
  sdp: z.string().min(1).max(64_000),
  model: z.string().min(1).max(128).optional(),
  threadId: z.string().min(1).max(64).optional(),
  temporary: z.boolean().optional(),
  voice: z.string().min(1).max(32).optional(),
});

const realtimeStopSchema = z.object({
  type: z.literal('realtime_stop'),
  requestId: z.string().min(1),
});

/** What to do with one message the device sent us. */
export type DeviceMessagePlan =
  | { readonly kind: 'voice_offer'; readonly offer: z.infer<typeof realtimeOfferSchema> }
  | { readonly kind: 'voice_stop'; readonly requestId: string }
  | { readonly kind: 'tool_reply'; readonly reply: DeviceMcpReply }
  | { readonly kind: 'drop'; readonly reason: string };

/**
 * Sort one message from the device.
 *
 * Three kinds matter: the two halves of a call, and the device answering a
 * tool call we sent it. Everything else the device may still say - its opening
 * `hello`, anything left over from an older firmware - is dropped on purpose
 * rather than silently accepted, so a message nobody handles shows up in the
 * log instead of vanishing.
 */
export function planDeviceMessage(rawText: string): DeviceMessagePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { kind: 'drop', reason: 'not JSON' };
  }
  const offer = realtimeOfferSchema.safeParse(parsed);
  if (offer.success) {
    return { kind: 'voice_offer', offer: offer.data };
  }
  const stop = realtimeStopSchema.safeParse(parsed);
  if (stop.success) {
    return { kind: 'voice_stop', requestId: stop.data.requestId };
  }
  const reply = deviceMcpReplySchema.safeParse(parsed);
  if (reply.success) {
    return { kind: 'tool_reply', reply: reply.data };
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return { kind: 'drop', reason: 'no type field' };
  }
  if (type === 'hello') {
    // The device announces itself on connect. We already know who it is from
    // the URL it dialled, so there is nothing to do with this.
    return { kind: 'drop', reason: 'hello' };
  }
  return { kind: 'drop', reason: `unhandled or malformed ${type}` };
}

/**
 * Turn one app-server voice event into the device's own message shape. Returns
 * null for anything the device has no business receiving.
 */
export function deviceMessageFromBridgeMessage(
  message: CodexBridgeMessage,
): ServerToDeviceMessage | null {
  switch (message.type) {
    case 'realtime_transcript_delta':
      return {
        type: 'realtime_transcript_delta',
        requestId: message.requestId,
        role: message.role,
        delta: message.delta,
      };
    case 'realtime_transcript_done':
      return {
        type: 'realtime_transcript_done',
        requestId: message.requestId,
        role: message.role,
        text: message.text,
      };
    case 'realtime_status':
      return {
        type: 'realtime_status',
        requestId: message.requestId,
        caption: message.caption,
        icon: message.icon,
        iconPixels: message.iconPixels,
      };
    default:
      return null;
  }
}

/**
 * The five things a working call needs, as far as this Mac can see them. They
 * are kept separate on purpose: "the call connected" and "the assistant's voice
 * came out of the speaker" are different facts, and a silent call is usually
 * one fact missing rather than all of them.
 */
export type CallFact =
  | 'offer_received'
  | 'answer_returned'
  | 'session_started'
  | 'user_transcript'
  | 'assistant_transcript'
  | 'error';

export interface CallEvidence {
  readonly requestId: string;
  readonly facts: ReadonlySet<CallFact>;
  readonly threadId: string | null;
  readonly offeredAtMilliseconds: number;
  readonly answeredAtMilliseconds: number | null;
  readonly assistantWords: number;
}

/**
 * A small, honest record of what one call reached. It exists to stop the two
 * easy lies: calling a call "working" because it connected, and calling it
 * working because captions appeared. Downlink audio is the device's speaker and
 * only a person standing there can confirm it.
 */
export class DirectVoiceCallLog {
  readonly #requestId: string;
  readonly #facts = new Set<CallFact>();
  #threadId: string | null = null;
  #offeredAtMilliseconds = Date.now();
  #answeredAtMilliseconds: number | null = null;
  #assistantWords = 0;

  constructor(requestId: string) {
    this.#requestId = requestId;
    this.#facts.add('offer_received');
  }

  noteAnswer(threadId: string): void {
    this.#facts.add('answer_returned');
    this.#answeredAtMilliseconds = Date.now();
    this.#threadId = threadId;
  }

  noteBridgeMessage(message: CodexBridgeMessage): void {
    switch (message.type) {
      case 'realtime_transcript_delta':
        this.#facts.add(
          message.role === 'user' ? 'user_transcript' : 'assistant_transcript',
        );
        if (message.role === 'assistant') {
          this.#assistantWords += countWords(message.delta);
        }
        return;
      case 'realtime_transcript_done':
        this.#facts.add(
          message.role === 'user' ? 'user_transcript' : 'assistant_transcript',
        );
        return;
      case 'realtime_status':
        this.#facts.add('session_started');
        return;
      default:
        return;
    }
  }

  noteError(): void {
    this.#facts.add('error');
  }

  get requestId(): string {
    return this.#requestId;
  }

  snapshot(): CallEvidence {
    return {
      requestId: this.#requestId,
      facts: new Set(this.#facts),
      threadId: this.#threadId,
      offeredAtMilliseconds: this.#offeredAtMilliseconds,
      answeredAtMilliseconds: this.#answeredAtMilliseconds,
      assistantWords: this.#assistantWords,
    };
  }

  /** One line a person can read while standing at the device. */
  describe(): string {
    const evidence = this.snapshot();
    const setup =
      evidence.answeredAtMilliseconds === null
        ? 'offer sent, no answer yet'
        : `answer in ${evidence.answeredAtMilliseconds - evidence.offeredAtMilliseconds} ms`;
    const parts = [
      setup,
      evidence.facts.has('session_started') ? 'voice session live' : 'no voice session event yet',
      evidence.facts.has('user_transcript') ? 'microphone heard' : 'microphone not heard yet',
      evidence.facts.has('assistant_transcript')
        ? `assistant spoke ${evidence.assistantWords} words`
        : 'assistant has not spoken yet',
    ];
    if (evidence.facts.has('error')) {
      parts.push('call reported an error');
    }
    if (evidence.facts.has('assistant_transcript')) {
      // Said plainly because it is the one thing this side cannot measure.
      parts.push('speaker audio must be confirmed by ear');
    }
    return parts.join('; ');
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The part of a WebRTC answer that decides whether audio can arrive at all.
 *
 * A session can look healthy in every way we watch - the transport pairs, the
 * event channel opens, the assistant's words arrive as captions - and still send
 * no voice, because the answer negotiated the audio stream as inactive, as
 * receive-only, or with a codec the device did not offer. The words travel on a
 * different channel from the voice, so nothing else notices. This is the one
 * line to compare between a call that spoke and a call that only transcribed.
 */
export function describeAnswerAudio(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const audioIndex = lines.findIndex((line) => line.startsWith('m=audio'));
  if (audioIndex < 0) {
    return 'no audio stream in the answer';
  }
  let direction = 'direction unstated';
  let codec = 'codec unstated';
  for (let index = audioIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.startsWith('m=')) {
      break;
    }
    if (line.startsWith('a=sendrecv') || line.startsWith('a=recvonly') ||
        line.startsWith('a=sendonly') || line.startsWith('a=inactive')) {
      direction = line.slice(2);
    } else if (line.startsWith('a=rtpmap:')) {
      codec = line.slice('a=rtpmap:'.length);
    }
  }
  return `${lines[audioIndex]!.trim()} (${direction}, ${codec})`;
}

/**
 * How the answer arranges its transports.
 *
 * The device offers one bundled transport for audio and events, and ICE-lite
 * only: it never gathers server-reflexive candidates and never starts
 * connectivity checks of its own, so everything it receives has to arrive on
 * the transport it offered. If the answer splits audio onto a second transport
 * with its own ICE credentials, the device is left with a working event
 * channel and no audio - which is exactly the fault seen on this hardware.
 * This line is how that gets confirmed or ruled out.
 */
export function describeAnswerTransports(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const bundleGroups: string[] = [];
  const transports: string[] = [];
  let currentMedia: string | null = null;
  let currentUfrag: string | null = null;
  const closeCurrent = (): void => {
    if (currentMedia !== null) {
      transports.push(currentMedia + ' ice=' + (currentUfrag ?? 'none'));
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('m=')) {
      closeCurrent();
      currentMedia = line.slice(2).split(' ')[0] ?? 'unknown';
      currentUfrag = null;
      continue;
    }
    if (line.startsWith('a=group:BUNDLE')) {
      bundleGroups.push(line.slice('a=group:BUNDLE'.length).trim());
      continue;
    }
    if (line.startsWith('a=ice-ufrag:')) {
      currentUfrag = line.slice('a=ice-ufrag:'.length);
    }
  }
  closeCurrent();
  const bundle = bundleGroups.length > 0 ? bundleGroups.join('|') : 'none';
  const shared = new Set(transports.map((entry) => entry.split('ice=')[1])).size === 1;
  return 'bundle=' + bundle + '; ' + transports.join(', ') + '; shared-transport=' + shared;
}
type ListenerConfiguration = {
  readonly port: number;
  readonly hostname: string;
  readonly deviceToken: string;
  readonly workingDirectory: string;
};

/** State carried on one device socket. */
type DeviceSocketData = {
  deviceId: string;
};

/**
 * The parts of a Bun server socket this file uses, stated structurally so the
 * listener does not have to pull Bun's own types into the whole project.
 */
type DeviceSocket = {
  readonly data: DeviceSocketData;
  readonly readyState: number;
  send(text: string): unknown;
};

async function readListenerConfiguration(arguments_: readonly string[]): Promise<ListenerConfiguration> {
  const environmentFilePath = process.env.APOLLO_BRIDGE_ENV_FILE ?? '.dev.vars';
  const variableMap = parseDevelopmentVariableMap(
    await Bun.file(environmentFilePath).text(),
  );
  const deviceToken =
    process.env.APOLLO_DEVICE_SECRET ??
    variableMap.get('DEVICE_SHARED_SECRET') ??
    '';
  if (deviceToken.length === 0) {
    throw new Error(
      'DEVICE_SHARED_SECRET is missing. Set it in .dev.vars, or pass APOLLO_DEVICE_SECRET.',
    );
  }
  const portFlagIndex = arguments_.indexOf('--port');
  const port =
    portFlagIndex >= 0 && arguments_[portFlagIndex + 1] !== undefined
      ? Number.parseInt(arguments_[portFlagIndex + 1], 10)
      : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Not a usable port: ${arguments_[portFlagIndex + 1] ?? '(missing)'}`);
  }
  return {
    port,
    hostname: process.env.APOLLO_DIRECT_VOICE_HOST ?? '0.0.0.0',
    deviceToken,
    workingDirectory: process.env.APOLLO_CODEX_CWD ?? process.cwd(),
  };
}

/**
 * Whether a request came from this Mac rather than from the network.
 *
 * Bun reports IPv4 clients as `127.0.0.1` and IPv6 ones as `::1`, and a machine
 * with both stacks can produce the IPv4-mapped `::ffff:127.0.0.1` for the same
 * connection. An address we cannot read at all is treated as remote: the safe
 * answer to "who is this?" is not "probably us".
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

/** Sends one message to the device, or reports that the device is gone. */
function sendToDevice(socket: DeviceSocket, text: string): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(text);
  } catch {
    console.error('Device stopped accepting messages; the call is over on its side.');
  }
}

export async function runListener(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const configuration = await readListenerConfiguration(arguments_);
  const codexClient = new CodexAppServerClient(configuration.workingDirectory);

  const activeCalls = new Map<string, DirectVoiceCallLog>();
  const deviceTools = new DeviceToolBridge();

  // Deliberate order: the port opens first, and only then does Codex start.
  // Codex reaches back to this same port for the device controls, so starting
  // it first means its very first attempt hits a closed port.
  const server = Bun.serve<DeviceSocketData>({
    hostname: configuration.hostname,
    port: configuration.port,
    fetch(request, socketServer) {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname === CONTROL_PATH) {
        // The device's controls are reachable from this Mac and nowhere else.
        // The device connection is guarded by a shared token; this one is not,
        // because Codex has no way to present it - so the guard is the network
        // instead. Anything arriving from the LAN is refused here.
        if (!isLoopbackAddress(socketServer.requestIP(request)?.address)) {
          console.error('Refused a device-control request from off this Mac.');
          return new Response('Forbidden', { status: 403 });
        }
        return handleControlRequest(request, deviceTools);
      }
      if (!requestUrl.pathname.startsWith(DEVICE_PATH_PREFIX)) {
        // Only the device and control paths are served. The device also asks
        // this host for a firmware version on boot; answering 404 is the honest
        // reply and the device logs it and carries on.
        return requestUrl.pathname === '/'
          ? new Response('esp32 voice mode listener\n', { status: 200 })
          : new Response('Not found', { status: 404 });
      }
      if (requestUrl.searchParams.get('token') !== configuration.deviceToken) {
        console.error('Refused a device connection with the wrong token.');
        return new Response('Unauthorized', { status: 401 });
      }
      const deviceId = decodeURIComponent(
        requestUrl.pathname.slice(DEVICE_PATH_PREFIX.length),
      );
      if (deviceId.length === 0) {
        return new Response('Missing device id', { status: 400 });
      }
      const upgraded = socketServer.upgrade(request, {
        data: { deviceId },
      });
      return upgraded ? undefined : new Response('Upgrade failed', { status: 400 });
    },
    websocket: {
      open(socket) {
        console.log(`Device "${socket.data.deviceId}" connected on the local network.`);
        // Its controls become available to Codex for as long as it is here.
        deviceTools.setDeviceConnection((text) => sendToDevice(socket, text));
      },
      message(socket, message) {
        if (typeof message !== 'string') {
          return;
        }
        const plan = planDeviceMessage(message);
        if (plan.kind === 'drop') {
          console.error(`Dropped a device message: ${plan.reason}.`);
          return;
        }
        if (plan.kind === 'tool_reply') {
          deviceTools.acceptReply(plan.reply);
          return;
        }
        if (plan.kind === 'voice_stop') {
          void codexClient.stopRealtimeSession(plan.requestId);
          const call = activeCalls.get(plan.requestId);
          if (call !== undefined) {
            console.log(`Call ended: ${call.describe()}`);
            activeCalls.delete(plan.requestId);
          }
          return;
        }

        const offer = plan.offer;
        const call = new DirectVoiceCallLog(offer.requestId);
        activeCalls.set(offer.requestId, call);
        console.log(
          `Voice offer ${offer.requestId}: ${offer.sdp.length} bytes of SDP, voice "${offer.voice ?? 'default'}".`,
        );
        // Codex takes about twenty seconds to come up, and the device can dial
        // in before then. Waiting here turns a lost first call into a slow one.
        void codexReady
          .then(() =>
            codexClient.startRealtimeSession(
            {
              type: 'realtime_offer',
              requestId: offer.requestId,
              sdp: offer.sdp,
              model: offer.model,
              threadId: offer.threadId,
              temporary: offer.temporary,
              voice: offer.voice,
            },
            (failureMessage) => {
              call.noteError();
              console.error(`Call ${offer.requestId} failed: ${failureMessage}`);
              sendToDevice(socket,
                encodeServerToDeviceMessage({
                  type: 'realtime_error',
                  requestId: offer.requestId,
                  message: describeRealtimeFailure(failureMessage),
                }),
              );
            },
            (bridgeMessage) => {
              const parsed = codexBridgeMessageSchema.safeParse(bridgeMessage);
              if (!parsed.success) {
                console.error('Ignored an unreadable app-server voice event.');
                return;
              }
              call.noteBridgeMessage(parsed.data);
              const deviceMessage = deviceMessageFromBridgeMessage(parsed.data);
              if (deviceMessage !== null) {
                sendToDevice(socket, encodeServerToDeviceMessage(deviceMessage));
              }
            },
          ))
          .then((result) => {
            call.noteAnswer(result.threadId);
            console.log(
              `Voice answer ${offer.requestId}: chat ${result.threadId}, bridge in ${Date.now() - (call.snapshot().offeredAtMilliseconds)} ms.`,
            );
            // The one line that separates a call that spoke from a call that
            // only transcribed, so a silent call can be compared with a good
            // one afterwards instead of guessed at.
            console.log(`Answer audio: ${describeAnswerAudio(result.sdp)}`);
            console.log(`Answer transports: ${describeAnswerTransports(result.sdp)}`);
            sendToDevice(socket,
              encodeServerToDeviceMessage({
                type: 'realtime_answer',
                requestId: offer.requestId,
                sdp: result.sdp,
                models: result.models.length > 0 ? [...result.models] : undefined,
                selectedModel: result.selectedModel ?? undefined,
                threadId: result.threadId,
                chats: result.chats.length > 0 ? [...result.chats] : undefined,
              }),
            );
          })
          .catch((error: unknown) => {
            call.noteError();
            const failureMessage =
              error instanceof Error ? error.message : String(error);
            console.error(`Voice call ${offer.requestId} could not start: ${failureMessage}`);
            sendToDevice(socket,
              encodeServerToDeviceMessage({
                type: 'realtime_error',
                requestId: offer.requestId,
                message: describeRealtimeFailure(failureMessage),
              }),
            );
          });
      },
      close(socket) {
        console.log(`Device "${socket.data.deviceId}" disconnected.`);
        deviceTools.setDeviceConnection(null);
        for (const call of activeCalls.values()) {
          void codexClient.stopRealtimeSession(call.requestId);
        }
        activeCalls.clear();
      },
    },
  });

  console.log(
    `Listening for the device on ws://${configuration.hostname}:${server.port}${DEVICE_PATH_PREFIX}<deviceId>`,
  );
  console.log(
    `Device controls for Codex on http://127.0.0.1:${server.port}${CONTROL_PATH}`,
  );

  // Only now: the port above is open, so Codex's first reach for the device
  // controls finds something listening. Handlers refer to this promise, and
  // none of them can run before this line, because Bun.serve returns as soon
  // as the port is bound and nothing else runs until this function yields.
  const codexReady = codexClient.start();
  await codexReady;
  console.log('Codex app-server ready.');

  const stop = (): void => {
    server.stop(true);
    codexClient.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// Guarded so the routers above can be imported by tests without starting a server.
if (import.meta.main) {
  try {
    await runListener();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
