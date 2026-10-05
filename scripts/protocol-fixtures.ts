#!/usr/bin/env bun
// Feed these real Mac messages into the firmware's host parser test.
import { encodeServerToDeviceMessage, type ServerToDeviceMessage } from '../src/protocol';

const messages: ServerToDeviceMessage[] = [
  {
    type: 'realtime_answer', requestId: 'contract-test', sdp: 'v=0\r\n',
    models: [{ id: 'contract-model', name: 'Test voice' }], selectedModel: 'contract-model',
    threadId: 'contract-chat', chats: [{ id: 'contract-chat', name: 'Hello desk', folder: 'Personal' }],
  },
  { type: 'realtime_status', requestId: 'contract-test', caption: 'Checking connection', icon: 'search' },
  { type: 'realtime_transcript_done', requestId: 'contract-test', role: 'assistant', text: 'Hello — مرحبًا' },
  { type: 'realtime_error', requestId: 'contract-test', message: 'Please choose another voice.' },
];
for (const message of messages) console.log(encodeServerToDeviceMessage(message));
