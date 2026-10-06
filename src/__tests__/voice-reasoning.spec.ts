import { expect, test } from 'bun:test';
import { buildCodexOverrides, voiceReasoningEffort, voiceThreadSettings, voiceThreadConfig, voiceChatUnavailable } from '../codex';
import { codexBridgeRealtimeRequestSchema } from '../codex-events';
import { classifyVoiceFailure } from '../failures';

test('new and resumed calls keep reasoning independent of the model, with device/config/low precedence', () => {
  const previous = process.env.VOICEMODE_CODEX_REASONING_EFFORT;
  try {
    delete process.env.VOICEMODE_CODEX_REASONING_EFFORT;
    expect(voiceChatUnavailable(new Error('session 123 is archived.'))).toBe(true);
    expect(voiceChatUnavailable(new Error('no rollout found for thread id 123'))).toBe(true);
    expect(voiceChatUnavailable(new Error('Model first does not support reasoning ultra'))).toBe(false);
    expect(buildCodexOverrides().some(value => value.includes('model_reasoning_effort'))).toBe(false);
    expect(voiceReasoningEffort('high', 'medium')).toBe('high');
    expect(voiceReasoningEffort(undefined, 'medium')).toBe('medium');
    expect(voiceReasoningEffort(undefined, null)).toBe('low');
    process.env.VOICEMODE_CODEX_REASONING_EFFORT = 'xhigh';
    expect(voiceReasoningEffort(undefined, 'medium')).toBe('xhigh');
    expect(voiceReasoningEffort('high', 'medium')).toBe('high');
    const catalog = ['first', 'second'].map(model => ({ model, displayName: model,
      supportedReasoningEffortList: ['low', 'high'], defaultReasoningEffort: 'low' }));
    for (const model of ['first', 'second']) {
      const settings = voiceThreadSettings(model, 'high', catalog);
      // Both thread/start and thread/resume use this same settings builder.
      expect(voiceThreadConfig(settings)).toEqual({ 'features.realtime_conversation': true,
        model, model_reasoning_effort: 'high' });
    }
    expect(voiceThreadSettings(undefined, 'low', [{ ...catalog[0]!, isDefault: true }]).model).toBe('first');
    expect(() => voiceThreadSettings('first', 'ultra', catalog)).toThrow('does not support reasoning ultra');
    expect(classifyVoiceFailure('Model first does not support reasoning ultra. Supported: low, high.').message).toContain('ultra');
    expect(codexBridgeRealtimeRequestSchema.parse({ type: 'realtime_offer', requestId: '1',
      sdp: 'v=0\r\n', reasoningEffort: 'high' })).toHaveProperty('reasoningEffort', 'high');
  } finally {
    if (previous === undefined) delete process.env.VOICEMODE_CODEX_REASONING_EFFORT;
    else process.env.VOICEMODE_CODEX_REASONING_EFFORT = previous;
  }
});
