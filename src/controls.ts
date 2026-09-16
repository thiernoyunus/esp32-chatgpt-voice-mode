/**
 * The device's own controls - volume, brightness, screen capture - offered to
 * Codex as tools.
 *
 * The device is itself a tool server: its firmware (main/mcp_server.cc)
 * declares `self.audio_speaker.set_volume` and friends and waits to be asked.
 * Something has to do the asking. That used to be the Cloudflare Worker; now
 * it is this file, over the same connection the call already runs on.
 *
 * Two sides:
 *
 *   Codex  --HTTP-->  this file  --websocket-->  the device
 *
 * Codex finds it at http://127.0.0.1:<port>/mcp. Register it once with:
 *
 *   codex mcp add desk --url http://127.0.0.1:8790/mcp
 *
 * If the device is not connected, every tool says so plainly rather than
 * hanging: an assistant that is told "the device is not connected" can say so
 * out loud, which is the whole point of it being a tool and not a silence.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { encodeServerToDeviceMessage, type DeviceMcpReply } from './protocol';

/**
 * How long to wait for the device to answer.
 *
 * Twenty seconds looks generous until you watch a screen capture: the device
 * grabs the display, encodes a JPEG and pushes it over wifi, all while the
 * audio path is running. Five seconds was the old ceiling and it failed calls
 * that would have succeeded a moment later. The fast tools answer in
 * milliseconds either way, so a high ceiling costs them nothing.
 */
const DEVICE_TOOL_TIMEOUT_MILLISECONDS = 20_000;

/** What the device sends back when a tool works. */
type DeviceToolOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: string };

type PendingCall = {
  readonly settle: (outcome: DeviceToolOutcome) => void;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
};

/**
 * Keeps track of tool calls sent to the device and the replies coming back.
 *
 * The device matches replies by id and silently ignores any request whose id is
 * not an integer, so ids are plain counting numbers here.
 */
export class DeviceToolBridge {
  readonly #pendingCalls = new Map<number, PendingCall>();
  #nextRequestId = 1;
  #sendToDevice: ((text: string) => void) | null = null;

  /** Called when a device connects or disconnects. */
  setDeviceConnection(send: ((text: string) => void) | null): void {
    this.#sendToDevice = send;
    if (send === null) {
      // A device that has gone away will never answer, so release every caller
      // now instead of making each one wait out its own timeout.
      for (const [requestId, pending] of this.#pendingCalls) {
        clearTimeout(pending.timeoutHandle);
        pending.settle({ ok: false, reason: 'the device disconnected mid-call' });
        this.#pendingCalls.delete(requestId);
      }
    }
  }

  get isDeviceConnected(): boolean {
    return this.#sendToDevice !== null;
  }

  /** Hand one reply from the device to whoever is waiting for it. */
  acceptReply(reply: DeviceMcpReply): void {
    const pending = this.#pendingCalls.get(reply.payload.id);
    if (pending === undefined) {
      // Almost always a reply that arrived after its caller gave up.
      return;
    }
    clearTimeout(pending.timeoutHandle);
    this.#pendingCalls.delete(reply.payload.id);
    console.log(
      reply.payload.error === undefined
        ? `Device answered #${reply.payload.id}: ${JSON.stringify(reply.payload.result)}`
        : `Device refused #${reply.payload.id}: ${reply.payload.error.message}`,
    );
    pending.settle(
      reply.payload.error === undefined
        ? { ok: true, result: reply.payload.result }
        : { ok: false, reason: reply.payload.error.message },
    );
  }

  /** Ask the device to run one of its tools. Never throws. */
  async call(
    toolName: string,
    argumentRecord: Record<string, unknown>,
  ): Promise<DeviceToolOutcome> {
    const send = this.#sendToDevice;
    if (send === null) {
      return { ok: false, reason: 'the device is not connected' };
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    // Logged on both sides: without this a tool call that never reaches the
    // device looks exactly like one the device ignored, and the assistant
    // inventing an answer looks like either.
    console.log(`Asking the device: ${toolName} ${JSON.stringify(argumentRecord)}`);

    return new Promise<DeviceToolOutcome>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.#pendingCalls.delete(requestId);
        resolve({
          ok: false,
          reason: `the device did not answer within ${DEVICE_TOOL_TIMEOUT_MILLISECONDS / 1000} seconds`,
        });
      }, DEVICE_TOOL_TIMEOUT_MILLISECONDS);

      this.#pendingCalls.set(requestId, { settle: resolve, timeoutHandle });

      try {
        send(
          encodeServerToDeviceMessage({
            type: 'mcp',
            payload: {
              jsonrpc: '2.0',
              id: requestId,
              method: 'tools/call',
              params: { name: toolName, arguments: argumentRecord },
            },
          }),
        );
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.#pendingCalls.delete(requestId);
        resolve({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}

/**
 * The device answers a screen capture with an image rather than text. Anything
 * else comes back as whatever the firmware returned, rendered as text.
 */
function describeOutcome(outcome: DeviceToolOutcome): CallToolResult {
  if (!outcome.ok) {
    return {
      content: [{ type: 'text', text: `Could not do that: ${outcome.reason}.` }],
      isError: true,
    };
  }
  const imageContent = readImageContent(outcome.result);
  if (imageContent !== null) {
    return { content: [imageContent] };
  }
  return {
    content: [
      {
        type: 'text',
        text:
          typeof outcome.result === 'string'
            ? outcome.result
            : JSON.stringify(outcome.result ?? 'done'),
      },
    ],
  };
}

const deviceImageResultSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.literal('image'),
        data: z.string().min(1),
        mimeType: z.string().min(1),
      }),
    )
    .min(1),
});

function readImageContent(
  result: unknown,
): { type: 'image'; data: string; mimeType: string } | null {
  const parsed = deviceImageResultSchema.safeParse(result);
  return parsed.success ? parsed.data.content[0]! : null;
}

/**
 * Build the tool server Codex talks to.
 *
 * Only four tools, because only four are worth an assistant's attention. The
 * firmware offers more - reboot, firmware upgrade, asset downloads - and those
 * are deliberately left out: nothing said in a voice call should be able to
 * restart the device or replace its firmware.
 */
export function createDeviceControlServer(bridge: DeviceToolBridge): McpServer {
  const server = new McpServer(
    { name: 'desk', version: '1.0.0' },
    {
      instructions:
        'Controls for the physical voice device on this desk. Check its status before changing volume or brightness, because both are set to an absolute value rather than nudged.',
    },
  );

  server.registerTool(
    'device_status',
    {
      title: 'Device status',
      description:
        'The device\'s current state: speaker volume, screen brightness, battery and network. Call this first when asked to change the volume or brightness, since those take an absolute 0-100 value.',
      inputSchema: {},
    },
    async () => describeOutcome(await bridge.call('self.get_device_status', {})),
  );

  server.registerTool(
    'set_volume',
    {
      title: 'Set speaker volume',
      description:
        'Set the device speaker volume to an absolute level from 0 to 100. To make it "louder" or "quieter", read device_status first and adjust from the value it reports.',
      inputSchema: { volume: z.number().int().min(0).max(100) },
    },
    async ({ volume }) =>
      describeOutcome(await bridge.call('self.audio_speaker.set_volume', { volume })),
  );

  server.registerTool(
    'set_brightness',
    {
      title: 'Set screen brightness',
      description:
        'Set the device screen brightness to an absolute level from 0 to 100. Read device_status first for relative changes.',
      inputSchema: { brightness: z.number().int().min(0).max(100) },
    },
    async ({ brightness }) =>
      describeOutcome(await bridge.call('self.screen.set_brightness', { brightness })),
  );

  server.registerTool(
    'capture_screen',
    {
      title: 'Capture the screen',
      description:
        "A JPEG of what the device's screen is showing right now. Takes a few seconds, because the device encodes and uploads it while a call is running.",
      inputSchema: { quality: z.number().int().min(1).max(100).default(80) },
    },
    async ({ quality }) =>
      describeOutcome(await bridge.call('self.screen.capture', { quality })),
  );

  return server;
}

/**
 * Answer one HTTP request from Codex.
 *
 * A fresh server and transport per request: every call here is one question and
 * one answer, so there is no session worth keeping, and keeping one would only
 * be state to get wrong.
 *
 * `enableJsonResponse` matters more than it looks. Without it the transport
 * replies with an open event stream, which suits a server that pushes updates
 * and does not suit this one at all: the reply would be written after the
 * function returns, so closing anything here would cut it off mid-sentence and
 * hand Codex an empty body. With it the whole answer is in the response, and
 * the request is genuinely finished when it is finished.
 */
export async function handleControlRequest(
  request: Request,
  bridge: DeviceToolBridge,
): Promise<Response> {
  console.log(
    `Codex reached the device controls${bridge.isDeviceConnected ? '' : ' (no device connected)'}.`,
  );
  const server = createDeviceControlServer(bridge);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
