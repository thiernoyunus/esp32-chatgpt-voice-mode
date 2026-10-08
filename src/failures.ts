/** Safe, short explanations for the device and local troubleshooting report. */
export function classifyVoiceFailure(message: string): { code: string; message: string } {
  if (/does not support reasoning/.test(message)) {
    const choice = /Model ([^ ]+) does not support reasoning ([^.]+)/.exec(message);
    return { code: 'reasoning_unsupported', message: choice ? `${choice[1]} cannot use reasoning ${choice[2]}. Change the level or model.` : 'This model cannot use that reasoning level. Change the level or model.' };
  }
  if (/Cannot verify reasoning/.test(message)) {
    return { code: 'reasoning_unverified', message: 'Can\'t check the reasoning level. Check your Codex model, then tap to try again.' };
  }
  if (/\b429\b|too many requests|rate.?limit|usage limit/i.test(message)) {
    return { code: 'usage_limit', message: 'You\'ve used up your ChatGPT voice time for now. It returns when the limit resets.' };
  }
  if (/voice model catalog unavailable/i.test(message)) {
    return { code: 'catalog_unavailable', message: 'Can\'t load the voice list. Make sure Codex is open on your Mac, then tap to try again.' };
  }
  if (/unknown voice model|model.+(?:not found|not available|unavailable|does not exist)/i.test(message)) {
    return { code: 'model_unavailable', message: 'That voice isn\'t available. Pick another one in Settings.' };
  }
  if (/operation not permitted|permission denied|EACCES|EPERM/i.test(message)) {
    return { code: 'permission_denied', message: 'Codex can\'t open its chat folder on your Mac. Run bun run doctor there.' };
  }
  if (/\b401\b|unauthorized|not (?:logged|signed) in|authentication|login required|sign.?in required/i.test(message)) {
    return { code: 'sign_in_required', message: 'Codex isn\'t signed in on your Mac. Open the Codex app and sign in.' };
  }
  if (/timed? ?out|timeout/i.test(message)) {
    return { code: 'setup_timeout', message: 'Your Mac took too long to answer. Tap to try again.' };
  }
  if (/ENOENT|executable.+not found|spawn.+failed/i.test(message)) {
    return { code: 'codex_missing', message: 'Codex can\'t start on your Mac. Run bun run doctor there.' };
  }
  if (/app-server stopped|ECONNREFUSED|ECONNRESET|connection (?:closed|lost)/i.test(message)) {
    return { code: 'codex_disconnected', message: 'Lost the connection to Codex on your Mac. Tap to try again.' };
  }
  if (/ChatGPT Voice closed: transport_closed/i.test(message)) {
    return { code: 'voice_connection_lost', message: 'The voice call dropped. Tap to try again.' };
  }
  // Raw failures can contain private paths, request bodies, or credentials.
  return { code: 'voice_failed', message: 'Voice couldn\'t start. Tap to try again, or run bun run doctor on your Mac.' };
}
