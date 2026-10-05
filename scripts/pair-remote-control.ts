// One-off: enrol this Mac's voice bridge as a ChatGPT remote-control client.
//
// Flow (see documentation/voice-chats-should-look-normal.md):
//   1. PKCE browser approval for scope codex.remote_control.enroll
//   2. enroll/start  -> client id + device key challenge
//   3. device key    -> non-extractable P-256 key in the login keychain
//   4. enroll/finish -> remote control token
//   5. pair          -> binds this client to the host (your 8-character code)
//
// Run:  bun run scripts/pair-remote-control.ts
// The pairing code is read from /tmp/rc-pair-code if it exists, otherwise from
// stdin, so the code can be supplied at the last moment (it is short-lived).

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const AUTH_ISSUER = 'https://auth.openai.com';
const API_BASE = 'https://chatgpt.com/backend-api';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'codex.remote_control.enroll';
const ORIGINATOR = 'Codex Desktop';
const STATE_PATH = '/tmp/rc-enrolment.json';
const CODE_PATH = '/tmp/rc-pair-code';
const KEY_LABEL = 'esp32-voice-bridge';

let accessToken = (() => {
  const auth = JSON.parse(readFileSync(process.env.HOME + '/.codex/auth.json', 'utf8'));
  const token = String(auth?.tokens?.access_token ?? '').trim();
  if (!token) throw new Error('no access token in ~/.codex/auth.json');
  return token;
})();

// Same resolution order the bridge itself uses, so a machine that keeps Codex
// somewhere else (or only on PATH) still works: an environment override, then
// the usual app location if it exists, then whatever "codex" resolves to.
const CODEX_BINARY =
  process.env.VOICEMODE_CODEX_BIN ??
  (existsSync('/Applications/ChatGPT.app/Contents/Resources/codex')
    ? '/Applications/ChatGPT.app/Contents/Resources/codex'
    : 'codex');

/**
 * Ask the Codex engine for a freshly minted sign-in token.
 *
 * The remote-control endpoints answer a stale token with 401
 * "remote_control_reauth_required", and the reference client's answer to that is
 * to refresh once and retry — not to fail. The engine already owns the refresh
 * plumbing, so this borrows it the same way the desktop app does.
 */
async function refreshedAccessToken(): Promise<string> {
  const child = spawn(CODEX_BINARY, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, (message: any) => void>();
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (typeof message.id === 'number' && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
      }
    } catch {
      // Ignore anything that is not a response.
    }
  });
  const request = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(method + ' timed out'));
      }, 90_000);
    });
  try {
    await request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: { name: 'esp32_voice_bridge_pair', title: 'ESP32 voice bridge pairing', version: '1.0.0' },
    });
    const status = await request('getAuthStatus', { includeToken: true, refreshToken: true });
    const token = String(status?.result?.authToken ?? '').trim();
    if (token === '') throw new Error('the Codex engine returned no auth token');
    return token;
  } finally {
    child.kill();
  }
}

// The ids the enrollment API and the authorize URL expect live in the
// "https://api.openai.com/auth" claim, not in sub: sub is an Auth0 user id
// (google-oauth2|...) and passing it as a workspace id fails authorization.
const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8'));
const authClaim = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, string>;
const storedAccountId = String(
  JSON.parse(readFileSync(process.env.HOME + '/.codex/auth.json', 'utf8'))?.tokens?.account_id ?? '',
);
const accountId = String(authClaim.chatgpt_account_id ?? authClaim.account_id ?? storedAccountId);
const accountUserId = String(authClaim.chatgpt_account_user_id ?? authClaim.account_user_id ?? '');
console.log('account id', accountId, '| account user', accountUserId);

async function api(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const attempt = () =>
    fetch(API_BASE + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        originator: ORIGINATOR,
        ...extraHeaders,
      },
      body: JSON.stringify(body ?? {}),
    });
  let response = await attempt();
  if (response.status === 401) {
    // Same rule the reference client uses: a 401 here means the token is stale,
    // so refresh once and retry before giving up.
    console.error('401 from ' + path + ' — refreshing the sign-in token and retrying once');
    accessToken = await refreshedAccessToken();
    response = await attempt();
  }
  const text = await response.text();
  if (!response.ok) throw new Error(path + ' -> HTTP ' + response.status + ' ' + text.slice(0, 300));
  return JSON.parse(text) as Record<string, unknown>;
}

function deviceKey(args: string[]): any {
  const out = execFileSync('./scripts/remote-control-device-key', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

const deviceIdentityHash = (identity: Record<string, string>) =>
  createHash('sha256')
    .update(JSON.stringify({
      algorithm: identity.algorithm,
      keyId: identity.keyId,
      protectionClass: identity.protectionClass,
      publicKeySpkiDerBase64: identity.publicKeySpkiDerBase64,
    }))
    .digest('base64url');

// Borrow a refreshed token and report its auth claims. Useful on its own: the
// worker endpoints care about how old the sign-in is, and this shows whether a
// refresh actually moves it.
if (process.argv.includes('--refresh-only')) {
  const fresh = await refreshedAccessToken();
  const claims = JSON.parse(Buffer.from(fresh.split('.')[1]!, 'base64url').toString('utf8'));
  const authNs = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const now = Date.now();
  console.log('refreshed token iat age (s):', Math.round(now / 1000 - (claims.iat ?? 0)));
  console.log('refreshed token pwd_auth_time age (s):',
    claims.pwd_auth_time ? Math.round((now - claims.pwd_auth_time) / 1000) : 'n/a');
  console.log('refreshed token amr:', JSON.stringify(authNs.amr ?? claims.amr));
  process.exit(0);
}

// Pairing an already-enrolled client needs no browser approval: enrollment is
// the one-time MFA-gated step, and this is just the 8-character code. Keeping
// them separate means an expired code costs a code, not another login.
if (process.argv.includes('--pair-only')) {
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { clientId: string };
  const code = readFileSync(CODE_PATH, 'utf8').trim().replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const paired = await api('/wham/remote/control/client/pair', {
    client_id: state.clientId,
    manual_pairing_code: code,
  }) as any;
  console.log('PAIRED. environment', paired.environment_id);
  process.exit(0);
}

// ---- 1. PKCE browser approval -------------------------------------------------

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(32).toString('base64url');

// The OAuth app accepts only its two registered loopback ports; any other one
// is refused with a bare "Authentication Error / unknown_error" after the user
// approves, which looks like a credentials problem but is the redirect.
// Take 1457 before 1455 on purpose: the Codex app tries 1455 first for its own
// sign-in callback, so sitting on 1455 is what made a normal Codex login land
// on this listener and get swallowed. Preferring the app's second choice keeps
// its preferred port free while we wait.
const CALLBACK_PORTS = [1457, 1455];
const callback = createServer();
let callbackPort = 0;
for (const candidate of CALLBACK_PORTS) {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      callback.once('error', onError);
      // Bind and name it exactly as the app does: the redirect URI is compared
      // as a literal string, and "localhost" is what the OAuth app has on
      // file. "127.0.0.1" is refused with a bare Authentication Error.
      callback.listen(candidate, 'localhost', () => {
        callback.off('error', onError);
        resolve();
      });
    });
    callbackPort = candidate;
    break;
  } catch {
    // Port taken: try the app's other registered port.
  }
}
if (callbackPort === 0) throw new Error('neither port 1455 nor 1457 is free');
const redirectUri = 'http://localhost:' + callbackPort + '/auth/callback';

const authorize = new URL('/oauth/authorize', AUTH_ISSUER);
authorize.search = new URLSearchParams({
  response_type: 'code',
  client_id: OAUTH_CLIENT_ID,
  redirect_uri: redirectUri,
  scope: SCOPE,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  originator: ORIGINATOR,
  reauth: 'remote_control',
  max_age: '0',
  codex_cli_simplified_flow: 'true',
  ...(accountId ? { allowed_workspace_id: accountId, current_workspace_id: accountId } : {}),
}).toString();

console.log('APPROVE THIS URL IN THE BROWSER:\n' + authorize.toString() + '\n');

const authorizationCode = await new Promise<string>((resolve, reject) => {
  // Generous: the approval can involve a full password + MFA login, and losing
  // the listener mid-login wastes the whole round trip.
  // Deliberately short: ports 1455/1457 are also the Codex app's own sign-in
  // callback, so while this listens a normal "sign in to Codex" can land here
  // and be swallowed. Hold the port for minutes, never half an hour.
  // Ten minutes: a password plus MFA needs room. Safe because this binds 1457
  // first and leaves 1455 - the port Codex prefers for its own sign-in - free.
  const timer = setTimeout(() => reject(new Error('approval timed out')), 10 * 60_000);
  callback.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(code ? 'Voice bridge authorised. You can close this tab.' : 'Authorisation failed.');
    if (!code || returnedState !== state) return;
    clearTimeout(timer);
    resolve(code);
  });
});

const tokenResponse = await fetch(AUTH_ISSUER + '/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: verifier,
  }).toString(),
});
const stepUpToken = String(((await tokenResponse.json()) as any)?.access_token ?? '');
if (!stepUpToken) throw new Error('no step-up token returned');
console.log('step-up token acquired');
// enroll/finish insists the approval came from a recent MFA login
// (remote_control_reauth_required), so print the claims that decide it.
const stepUpClaims = JSON.parse(Buffer.from(stepUpToken.split('.')[1]!, 'base64url').toString('utf8'));
const authNamespace = (stepUpClaims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
const nowMs = Date.now();
// The app requires pwd_auth_time within 300 seconds, and the server enforces
// the same thing as remote_control_reauth_required.
console.log('claim keys:', Object.keys(stepUpClaims).sort().join(','));
console.log('iat', stepUpClaims.iat, '(age', Math.round(nowMs / 1000 - (stepUpClaims.iat ?? 0)), 's)',
  '| pwd_auth_time', stepUpClaims.pwd_auth_time,
  '(age', stepUpClaims.pwd_auth_time ? Math.round(nowMs - stepUpClaims.pwd_auth_time) : 'n/a', 's)',
  '| auth_time', stepUpClaims.auth_time);
console.log('scopes', JSON.stringify(stepUpClaims.scope ?? stepUpClaims.scp),
  '| amr', JSON.stringify(authNamespace.amr ?? stepUpClaims.amr),
  '| auth claim keys', Object.keys(authNamespace).sort().join(','));

// ---- 2. challenge + device key ------------------------------------------------

const start = await api('/codex/remote/control/client/enroll/start', {}) as any;
const keyChallenge = start.device_key_challenge;
// The helper creates the key and signs in one process: a keychain key used from
// a different process than the one that created it raises the macOS
// "wants to use your keychain" prompt and blocks with nobody watching.
const proof = deviceKey(['proof', KEY_LABEL, Buffer.from(JSON.stringify({
  nonce: keyChallenge.nonce,
  challengeId: keyChallenge.challenge_id,
  targetOrigin: keyChallenge.target_origin,
  targetPath: keyChallenge.target_path,
  accountUserId: keyChallenge.account_user_id,
  clientId: keyChallenge.client_id,
  challengeExpiresAt: keyChallenge.challenge_expires_at,
})).toString('base64')]);
console.log('device key created and challenge signed');

// ---- 3. finish + pair ----------------------------------------------------------

const finishBody = {
  client_id: start.client_id,
  step_up_token: stepUpToken,
  device_identity: {
    key_id: proof.keyId,
    public_key_spki_der_base64: proof.publicKeySpkiDerBase64,
    algorithm: proof.algorithm,
    protection_class: proof.protectionClass,
  },
  device_key_proof: {
    challenge_token: keyChallenge.challenge_token,
    key_id: proof.keyId,
    signature_der_base64: proof.signatureDerBase64,
    signed_payload_base64: proof.signedPayloadBase64,
    algorithm: proof.algorithm,
  },
};

let finish: any;
try {
  finish = await api('/codex/remote/control/client/enroll/finish', finishBody);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('HTTP 401')) throw error;
  // The refusal names a recent MFA login. Refreshing the account token carries
  // the password age forward rather than resetting it, but the approval we just
  // completed IS a recent MFA login - so retry the endpoint authenticated by
  // that approval token itself.
  console.error('finish refused with the account token; retrying authenticated by the approval token');
  finish = await api('/codex/remote/control/client/enroll/finish', finishBody, {
    Authorization: 'Bearer ' + stepUpToken,
  });
}

const token = String(finish.remote_control_token ?? finish.token ?? '');
writeFileSync(STATE_PATH, JSON.stringify({
  clientId: start.client_id,
  accountUserId,
  remoteControlToken: token,
  websocketUrl: finish.websocket_url ?? 'wss://chatgpt.com/backend-api/wham/remote/control/client',
  enrolledAt: new Date().toISOString(),
}, null, 2));
console.log('enrolled. client id', start.client_id);

const readCode = (() => {
  try { return readFileSync(CODE_PATH, 'utf8').trim(); } catch { return ''; }
})();
let pairingCode = readCode;
if (!pairingCode) {
  console.log('WAITING FOR PAIRING CODE: put the 8 characters in ' + CODE_PATH);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && pairingCode === '') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try { pairingCode = readFileSync(CODE_PATH, 'utf8').trim(); } catch { pairingCode = ''; }
  }
}
if (!pairingCode) throw new Error('no pairing code supplied');

const paired = await api('/wham/remote/control/client/pair', {
  client_id: start.client_id,
  manual_pairing_code: pairingCode.replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
}) as any;
console.log('PAIRED. environment', paired.environment_id);
