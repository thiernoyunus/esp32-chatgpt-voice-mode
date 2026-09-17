/**
 * What comes back out of a live voice session, and what goes into starting one.
 *
 * These used to be messages in the literal sense: the Codex bridge and the
 * Cloudflare Worker were separate programs passing JSON over a socket, so every
 * event was encoded, sent, received and parsed. They are now two objects in one
 * process. The only reason these shapes are still checked at runtime is that
 * they originate in the Codex app-server, which *is* a separate program and can
 * change underneath us.
 */

import { z } from 'zod';

import { realtimeIconPixelsSchema, realtimeStatusIconSchema } from './protocol';

/** Sent to the Codex app-server as our client version during the handshake. */
export const CLIENT_VERSION = '2';

const realtimeSdpSchema = z.string().min(1).max(64_000);

/**
 * Everything a running call reports. Three kinds and no more: the app-server
 * hands back the answer directly and reports failures through its own callback,
 * so neither an answer nor an error travels this way.
 */
export const codexBridgeMessageSchema = z.discriminatedUnion('type', [
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
]);

export type CodexBridgeMessage = z.infer<typeof codexBridgeMessageSchema>;

export const codexBridgeRealtimeRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('realtime_offer'),
    requestId: z.string().min(1),
    sdp: realtimeSdpSchema,
    model: z.string().min(1).max(128).optional(),
    // Resume this saved chat instead of opening a new one. Absent = new chat.
    threadId: z.string().min(1).max(64).optional(),
    // Opt-in throwaway chat; absent/false keeps the chat in the Codex sidebar.
    temporary: z.boolean().optional(),
    // Spoken voice for this call; absent uses the ChatGPT default.
    voice: z.string().min(1).max(32).optional(),
  }),
  z.object({
    type: z.literal('realtime_stop'),
    requestId: z.string().min(1),
  }),
]);

export type CodexBridgeRealtimeRequest = z.infer<
  typeof codexBridgeRealtimeRequestSchema
>;
