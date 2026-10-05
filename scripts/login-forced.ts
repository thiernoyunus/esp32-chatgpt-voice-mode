// Log the account in again while forcing a fresh authentication.
//
// "codex login" silently reuses the browser session, and because this account is
// federated to Google that mints a token with no password factor - the one thing
// the remote-control enrolment keeps asking for. The remote-control approval
// does produce a password factor, because it sends max_age=0 with
// reauth=remote_control. This performs the ordinary Codex login with those same
// forcing parameters.
//
//   bun run scripts/login-forced.ts            (max_age=0 + reauth=remote_control)
//   bun run scripts/login-forced.ts --no-reauth (max_age=0 only)
//
// Writes ~/.codex/auth.json after backing it up, and prints the new token's
// authentication factor so the result can be judged before anything else runs.

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const AUTH_ISSUER = 'https://auth.openai.com';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const ORIGINATOR = 'Codex Desktop';
const AUTH_PATH = process.env.HOME + '/.codex/auth.json';
const PORTS = [1455, 1457];
const useReauth = !process.argv.includes('--no-reauth');

const backupPath = AUTH_PATH + '.bak-forced-login-' + new Date().toISOString().replace(/[:.]/gu, '-');
copyFileSync(AUTH_PATH, backupPath);
console.log('backed up auth.json ->', backupPath);

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(32).toString('base64url');

const server = createServer();
let port = 0;
for (const candidate of PORTS) {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(candidate, 'localhost', () => {
        server.off('error', onError);
        resolve();
      });
    });
    port = candidate;
    break;
  } catch {
    // Try the other registered loopback port.
  }
}
if (port === 0) throw new Error('neither 1455 nor 1457 is free');
const redirectUri = 'http://localhost:' + port + '/auth/callback';

const authorize = new URL('/oauth/authorize', AUTH_ISSUER);
authorize.search = new URLSearchParams({
  response_type: 'code',
  client_id: OAUTH_CLIENT_ID,
  redirect_uri: redirectUri,
  scope: SCOPES,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  originator: ORIGINATOR,
  max_age: '0',
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  ...(useReauth ? { reauth: 'remote_control' } : {}),
}).toString();

console.log('OPEN THIS URL IN YOUR DEFAULT BROWSER (reauth=' + useReauth + '):');
console.log(authorize.toString());
console.log('');

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('login timed out')), 10 * 60_000);
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const received = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(received ? 'Signed in. You can close this tab.' : 'Sign-in failed.');
    if (received && returnedState === state) {
      clearTimeout(timer);
      resolve(received);
    }
  });
});

const tokenResponse = await fetch(AUTH_ISSUER + '/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: verifier,
  }).toString(),
});
if (!tokenResponse.ok) throw new Error('token exchange failed: ' + tokenResponse.status + ' ' + (await tokenResponse.text()).slice(0, 200));
const tokens = await tokenResponse.json() as Record<string, string>;
if (!tokens.access_token) throw new Error('no access token returned');

const existing = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString('utf8'));
const authNs = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;

writeFileSync(AUTH_PATH, JSON.stringify({
  ...existing,
  tokens: {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? existing?.tokens?.refresh_token,
    id_token: tokens.id_token ?? existing?.tokens?.id_token,
    account_id: authNs.chatgpt_account_id ?? existing?.tokens?.account_id,
  },
  last_refresh: new Date().toISOString(),
}, null, 2));
console.log('auth.json updated');

const now = Date.now();
console.log('new token amr               :', JSON.stringify(authNs.amr ?? claims.amr));
console.log('new token pwd_auth_time age :', claims.pwd_auth_time ? Math.round((now - claims.pwd_auth_time) / 1000) + ' s' : 'absent');
console.log('HAS PASSWORD FACTOR         :', String(JSON.stringify(authNs.amr ?? []).includes('pwd')));

