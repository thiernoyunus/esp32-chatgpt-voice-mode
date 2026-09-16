import { describe, expect, it } from 'bun:test';

import { codexBridgeMessageSchema } from '../codex-events';
import {
  encodeServerToDeviceMessage,
  serverToDeviceMessageSchema,
} from '../protocol';
import {
  DirectVoiceCallLog,
  describeAnswerAudio,
  deviceMessageFromBridgeMessage,
  isLoopbackAddress,
  planDeviceMessage,
} from '../listener';

const OFFER = JSON.stringify({
  type: 'realtime_offer',
  requestId: 'call-1',
  sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n',
  voice: 'cove',
});

describe('reading the answer the device will get', () => {
  const answer = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=sendrecv',
    'a=rtpmap:999 nothing/1',
  ].join('\r\n');

  it('reports the audio stream, not the first track it finds', () => {
    const described = describeAnswerAudio(answer);
    expect(described).toContain('m=audio 9 UDP/TLS/RTP/SAVPF 111');
    expect(described).toContain('opus/48000/2');
    expect(described).toContain('sendrecv');
  });

  it('says so when the answer carries no audio at all', () => {
    expect(describeAnswerAudio('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n')).toBe(
      'no audio stream in the answer',
    );
  });

  it('shows a receive-only audio stream, which is a call that can only listen', () => {
    const described = describeAnswerAudio(
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\na=rtpmap:111 opus/48000/2\r\n',
    );
    expect(described).toContain('recvonly');
  });
});

describe('device message routing', () => {
  it('recognises an offer as the start of a call', () => {
    const plan = planDeviceMessage(OFFER);
    expect(plan.kind).toBe('voice_offer');
    if (plan.kind !== 'voice_offer') {
      return;
    }
    expect(plan.offer.requestId).toBe('call-1');
    expect(plan.offer.voice).toBe('cove');
  });

  it('recognises a stop as the end of one', () => {
    const plan = planDeviceMessage(
      JSON.stringify({ type: 'realtime_stop', requestId: 'call-1' }),
    );
    expect(plan).toEqual({ kind: 'voice_stop', requestId: 'call-1' });
  });

  it('drops a malformed offer rather than half-answering it', () => {
    const plan = planDeviceMessage(JSON.stringify({ type: 'realtime_offer' }));
    expect(plan.kind).toBe('drop');
  });

  it('picks out the device answering a tool call', () => {
    const plan = planDeviceMessage(
      JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 4, result: true } }),
    );
    expect(plan.kind).toBe('tool_reply');
    expect(plan.kind === 'tool_reply' && plan.reply.payload.id).toBe(4);
  });

  it('drops what nothing here handles, naming it so it shows up in the log', () => {
    // These were all real messages once, back when a Worker was listening.
    for (const message of [
      { type: 'hello', deviceId: 'desk', ts: 1 },
      { type: 'telemetry', ts: 1 },
      { type: 'gesture', gesture: 'tap', ts: 1 },
    ]) {
      const plan = planDeviceMessage(JSON.stringify(message));
      expect(plan.kind).toBe('drop');
      expect(plan.kind === 'drop' && plan.reason).toContain(message.type);
    }
  });

  it('drops text it cannot recognise as a message', () => {
    expect(planDeviceMessage('not json').kind).toBe('drop');
    expect(planDeviceMessage('{}').kind).toBe('drop');
    expect(planDeviceMessage('[1,2,3]').kind).toBe('drop');
  });
});

describe('who may reach the device controls', () => {
  it('lets this Mac through, on either stack', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('refuses the rest of the network, and anything it cannot identify', () => {
    expect(isLoopbackAddress('10.0.0.42')).toBe(false);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    // A near-miss that must not pass: same prefix, different machine.
    expect(isLoopbackAddress('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('voice events on their way to the device', () => {
  it('sends assistant speech and captions in the shapes the device already parses', () => {
    const messages = [
      {
        type: 'realtime_transcript_delta' as const,
        requestId: 'call-1',
        role: 'assistant' as const,
        delta: 'Hi, I am here.',
      },
      {
        type: 'realtime_transcript_done' as const,
        requestId: 'call-1',
        role: 'assistant' as const,
        text: 'Hi, I am here.',
      },
      {
        type: 'realtime_status' as const,
        requestId: 'call-1',
        caption: 'Search email',
        icon: 'search' as const,
      },
    ];
    for (const message of messages) {
      const deviceMessage = deviceMessageFromBridgeMessage(message);
      expect(deviceMessage).not.toBeNull();
      // Round-tripping through the real encoder is the check that matters: it
      // is the validator the listener itself uses, so anything passing here is
      // something the device is already built to accept.
      const encoded = encodeServerToDeviceMessage(deviceMessage!);
      const parsed = serverToDeviceMessageSchema.parse(JSON.parse(encoded));
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(deviceMessage));
    }
  });

  it('keeps the answer the listener returns valid for the device', () => {
    const encoded = encodeServerToDeviceMessage({
      type: 'realtime_answer',
      requestId: 'call-1',
      sdp: 'v=0\r\n',
      models: [{ id: 'gpt-5.6-luna', name: 'Luna' }],
      selectedModel: 'gpt-5.6-luna',
      threadId: 'thread-1',
      chats: [{ id: 'thread-1', name: 'Desk voice chat' }],
    });
    expect(serverToDeviceMessageSchema.parse(JSON.parse(encoded)).type).toBe(
      'realtime_answer',
    );
  });

  it('accepts what the app-server actually sends', () => {
    // Fed through the same validator the listener uses on a live event, so this
    // is the real shape rather than a hand-built lookalike.
    const fromAppServer = codexBridgeMessageSchema.parse({
      type: 'realtime_transcript_delta',
      requestId: 'call-1',
      role: 'user',
      delta: 'what is four plus four',
    });
    const deviceMessage = deviceMessageFromBridgeMessage(fromAppServer);
    expect(deviceMessage).not.toBeNull();
    expect(deviceMessage!.type).toBe('realtime_transcript_delta');
  });
});

describe('what a call can honestly claim', () => {
  it('starts with what is true and nothing more', () => {
    const call = new DirectVoiceCallLog('call-1');
    const described = call.describe();
    expect(described).toContain('no answer yet');
    expect(described).toContain('assistant has not spoken yet');
    // The one thing this side can never measure.
    expect(described).not.toContain('speaker audio');
  });

  it('never claims the speaker from captions alone', () => {
    const call = new DirectVoiceCallLog('call-1');
    call.noteAnswer('thread-1');
    call.noteBridgeMessage({
      type: 'realtime_transcript_delta',
      requestId: 'call-1',
      role: 'assistant',
      delta: 'Hi, I am here.',
    });
    const described = call.describe();
    expect(described).toContain('assistant spoke 4 words');
    // Captions are proof of words, not of sound out of the speaker.
    expect(described).toContain('must be confirmed by ear');
  });

  it('separates the microphone reaching the assistant from the assistant answering', () => {
    const call = new DirectVoiceCallLog('call-1');
    call.noteBridgeMessage({
      type: 'realtime_transcript_delta',
      requestId: 'call-1',
      role: 'user',
      delta: 'hello',
    });
    const evidence = call.snapshot();
    expect(evidence.facts.has('user_transcript')).toBe(true);
    expect(evidence.facts.has('assistant_transcript')).toBe(false);
  });

  it('records a failure instead of describing it as a live call', () => {
    const call = new DirectVoiceCallLog('call-1');
    call.noteError();
    expect(call.describe()).toContain('reported an error');
    expect(call.snapshot().facts.has('answer_returned')).toBe(false);
  });
});
