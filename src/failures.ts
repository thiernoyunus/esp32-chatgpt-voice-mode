/** Safe, short explanations for the device and local troubleshooting report. */
export function classifyVoiceFailure(message: string): { code: string; message: string } {
  if (/\b429\b|too many requests|rate.?limit|usage limit/i.test(message)) {
    return { code: 'usage_limit', message: 'ChatGPT usage limit reached. Voice returns when it resets.' };
  }
  if (/voice model catalog unavailable/i.test(message)) {
    return { code: 'catalog_unavailable', message: 'Cannot load voice choices. Check Codex on your Mac and retry.' };
  }
  if (/unknown voice model|model.+(?:not found|not available|unavailable|does not exist)/i.test(message)) {
    return { code: 'model_unavailable', message: 'This voice model is unavailable. Choose another in Settings.' };
  }
  if (/operation not permitted|permission denied|EACCES|EPERM/i.test(message)) {
    return { code: 'permission_denied', message: 'Codex cannot open its chat folder. Run bun run doctor on your Mac.' };
  }
  if (/\b401\b|unauthorized|not (?:logged|signed) in|authentication|login required|sign.?in required/i.test(message)) {
    return { code: 'sign_in_required', message: 'Check your Codex sign-in on the Mac, then retry.' };
  }
  if (/timed? ?out|timeout/i.test(message)) {
    return { code: 'setup_timeout', message: 'Voice setup took too long. Check Codex on your Mac and retry.' };
  }
  if (/ENOENT|executable.+not found|spawn.+failed/i.test(message)) {
    return { code: 'codex_missing', message: 'Cannot start Codex. Run bun run doctor on your Mac.' };
  }
  if (/app-server stopped|ECONNREFUSED|ECONNRESET|connection (?:closed|lost)/i.test(message)) {
    return { code: 'codex_disconnected', message: 'Lost the Codex connection. Check your Mac and retry.' };
  }
  if (/ChatGPT Voice closed: transport_closed/i.test(message)) {
    return { code: 'voice_connection_lost', message: 'Voice connection dropped. Tap to reconnect.' };
  }
  // Raw failures can contain private paths, request bodies, or credentials.
  return { code: 'voice_failed', message: 'Voice could not start. Run bun run doctor on your Mac.' };
}
