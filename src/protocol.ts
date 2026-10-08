/**
 * The wire format between the Mac and the device.
 *
 * This is deliberately small: it holds exactly the messages the device's
 * codex_voice_protocol.cc actually sends and handles, and nothing else. The
 * earlier server spoke a much larger dialect - screen states, timers,
 * reminders, sound effects, text-to-speech framing - and the device stopped
 * understanding all of it when it moved to the Codex voice protocol. Keeping
 * those definitions around would only invite someone to send one.
 *
 * Whenever this file changes, main/protocols/codex_voice_protocol.cc in the
 * firmware checkout has to change with it. They are two halves of one format.
 */

import { z } from 'zod';

const realtimeSdpSchema = z.string().min(1).max(64_000);

/** The small picture the device draws beside a status caption. */
export const realtimeStatusIconSchema = z.enum(['none', 'search']);

export type RealtimeStatusIconName = z.infer<typeof realtimeStatusIconSchema>;

/** A 32x32 one-bit icon, base64. The device allocates for exactly this size. */
export const realtimeIconPixelsSchema = z
  .string()
  .length(3072)
  .regex(/^[A-Za-z0-9+/]+$/);

/**
 * The device answering a tool call we sent it.
 *
 * The device's McpServer silently drops requests whose id is a string, so the
 * id is an integer on both halves of this exchange.
 */
export const deviceMcpReplySchema = z.object({
  type: z.literal('mcp'),
  payload: z.object({
    jsonrpc: z.literal('2.0'),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int().optional(),
        message: z.string().min(1),
      })
      .optional(),
  }),
});

export type DeviceMcpReply = z.infer<typeof deviceMcpReplySchema>;

const watchChatLabelSchema = z.string().min(1).max(60).refine(value => Buffer.byteLength(value, 'utf8') <= 60, 'Watch chat labels must fit 60 UTF-8 bytes');

export const voiceChatListSchema = z.array(z.object({
  id: z.string().min(1).max(64), name: watchChatLabelSchema,
  folder: watchChatLabelSchema.optional(),
})).max(20);

export const serverToDeviceMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('realtime_answer'),
    requestId: z.string().min(1),
    sdp: realtimeSdpSchema,
    models: z
      .array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(80) }))
      .max(40)
      .optional(),
    selectedModel: z.string().min(1).max(128).optional(),
    threadId: z.string().min(1).max(64).optional(),
    chats: voiceChatListSchema.optional(),
  }),
  z.object({ type: z.literal('chat_list'), requestId: z.string().min(1).max(64), chats: voiceChatListSchema }),
  // Answer to the watch's Status page: whether calls can reach the Codex
  // app's project tools right now (the app is open and its helper answers).
  z.object({ type: z.literal('status'), codexApp: z.boolean() }),
  z.object({
    type: z.literal('realtime_transcript_delta'),
    requestId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('realtime_transcript_done'),
    requestId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('realtime_status'),
    requestId: z.string().min(1),
    caption: z.string().min(1).max(80),
    icon: realtimeStatusIconSchema.optional(),
    iconPixels: realtimeIconPixelsSchema.optional(),
  }),
  z.object({
    type: z.literal('realtime_error'),
    requestId: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('mcp'),
    payload: z.object({
      jsonrpc: z.literal('2.0'),
      id: z.number().int(),
      method: z.string().min(1),
      params: z.record(z.unknown()).optional(),
    }),
  }),
]);

export type ServerToDeviceMessage = z.infer<typeof serverToDeviceMessageSchema>;

export function encodeServerToDeviceMessage(message: ServerToDeviceMessage): string {
  return JSON.stringify(serverToDeviceMessageSchema.parse(message));
}
