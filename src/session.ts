// Browser sign-in for the CLI, and the session-backed auth provider it
// produces. `brass login` runs the RFC 8628 device-authorization grant: the
// CLI mints a grant, opens the browser to the approval page with the user
// code prefilled (and prints the URL + code as a fallback for a headless
// box), then polls until the human approves. Approval mints the same tokens
// `/refresh` returns, including the opaque `session_token` the CLI stores to
// keep refreshing, which is bound to the CLI's own app id. That app's
// registered redirect URLs are the loopback wildcards, which is what lets the
// portless 127.0.0.1 origin below pass the `/refresh` Origin check on every
// later token refresh.

import { spawn } from 'node:child_process';
import { BrassApiError, networkError } from './api.js';
import type { AuthProvider } from './auth.js';

// Every auth call carries a few hundred bytes, so a host still silent after
// this is one that is not going to answer.
const AUTH_TIMEOUT_MS = 15_000;
// Signing out on the server is best effort: `runLogout` clears the local
// credential whatever this returns, so a host that stalls must not be what
// stops the credential being cleared.
const SIGN_OUT_TIMEOUT_MS = 5_000;

// The app id the CLI signs in as. Stable across environments, so one CLI
// build authenticates against whichever stack the origin flags name.
export const CLI_APP_ID = 'brass_app_internal_cli';

// The Origin the CLI presents on every `/refresh` call (a command refreshing
// its access token from the stored session). The CLI app's loopback wildcard
// allowlist matches any 127.0.0.1 origin, port ignored, so this portless
// loopback origin passes the `/refresh` Origin gate.
const REFRESH_ORIGIN = 'http://127.0.0.1';

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RefreshedTokens {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  // Present only on the initial device-grant token exchange: the opaque
  // session pointer the CLI persists and echoes on later refreshes. Bound to
  // the CLI's app id, so a copy of it authenticates as the CLI and nothing
  // else.
  sessionToken?: string;
}

interface RefreshWire {
  access_token: string;
  id_token: string;
  expires_in: number;
  session_token?: string;
}

// The lifetime to stamp a token set with, given whatever `expires_in` the
// response carried. Every value that is not a positive finite number stamps an
// `expiresAt` the refresh guard `Date.now() >= expiresAt` reads wrong: a
// missing or non-numeric one makes it NaN, so every comparison is false and
// the token is never re-refreshed, and a zero or negative one makes it already
// past, so every call refreshes again. The SDK's `tokenTtlSeconds` is the same
// guard on the same field.
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
function tokenTtlSeconds(expiresIn: unknown): number {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn
    : DEFAULT_TOKEN_TTL_SECONDS;
}

// Refresh an access token at `/refresh` from the stored session pointer
// (`sid`). A form-encoded body keeps this a CORS simple request (the auth API
// serves no preflight); the Origin header is required by the endpoint's
// allowlist and satisfied by a loopback origin.
export async function postRefresh(
  authBaseUrl: string,
  sid: string,
  origin: string = REFRESH_ORIGIN,
  now: number = Date.now(),
): Promise<RefreshedTokens> {
  const body = new URLSearchParams({ sid });
  const url = `${authBaseUrl}/refresh?${new URLSearchParams({ app_id: CLI_APP_ID }).toString()}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body,
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw networkError(`reaching ${authBaseUrl}`, cause);
  }
  if (!response.ok) {
    // Carry the status, and name what a 401 means. Every command reaches the
    // data API through this refresh, so this error is what the caller
    // classifies the whole attempt by, and a status-free error here is
    // indistinguishable from a request that never completed: that is what
    // turns an expired session into a report of an unreachable API.
    throw new BrassApiError(
      response.status,
      response.status === 401
        ? `Your Brass sign-in is no longer valid (401). Run 'brass login' to sign in again.`
        : `Sign-in exchange failed (${response.status}).`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as Partial<RefreshWire>;
  // A 200 carrying no tokens is a failed exchange whatever the status said.
  // Taken here because the fields are read unchecked otherwise: an absent
  // `access_token` is stored as `undefined` and presented as the literal
  // header `Bearer undefined`, which comes back 401 and is reported as an
  // expired sign-in, sending the caller to `brass login` for a session that
  // was never the problem. `pollDeviceToken` requires both fields already.
  if (!json.access_token || !json.id_token) {
    throw new BrassApiError(
      response.status,
      `Sign-in exchange returned no tokens (${response.status}).`,
    );
  }
  return {
    accessToken: json.access_token,
    idToken: json.id_token,
    expiresAt: now + tokenTtlSeconds(json.expires_in) * 1000,
    ...(json.session_token ? { sessionToken: json.session_token } : {}),
  };
}

// End this machine's sign-in on the server, not only in the local
// credentials file. The stored pointer keeps minting access tokens for the
// rest of the session's life, so forgetting it locally leaves a working
// credential behind wherever a copy of the file went.
//
// Reports whether the server confirmed it. The stored pointer is the caller's
// only handle on the session, so what the caller does with the record follows
// from this: an undelivered revoke keeps it for the retry.
export async function postSignOut(
  authBaseUrl: string,
  sid: string,
  origin: string = REFRESH_ORIGIN,
): Promise<boolean> {
  const url = `${authBaseUrl}/sign-out-of-app?${new URLSearchParams({ app_id: CLI_APP_ID }).toString()}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams({ sid }),
      signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
    });
    // A 401 means the pointer no longer resolves, which is the state the
    // caller wanted: there is nothing left to revoke.
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

// Abandon a sign-in this machine started and never redeemed, so the code it
// relayed to a human stops being redeemable. Reports whether the server took
// it, like `postSignOut`: the record naming the grant is the caller's only
// handle on it, so what the caller does with the record follows from this.
export async function postDeviceCancel(
  authBaseUrl: string,
  deviceCode: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${authBaseUrl}/device/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ device_code: deviceCode, app_id: CLI_APP_ID }),
      signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Decode the email claim from an id token, best-effort (used only for the
// "Signed in as ..." confirmation; never for authorization).
export function decodeEmail(idToken: string): string | undefined {
  const part = idToken.split('.')[1];
  if (part === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

export interface LoginResult {
  sessionToken: string;
  email: string | undefined;
}

// --- Device-authorization grant (RFC 8628) ---
// The CLI shows a URL + short code (and opens the URL with the code
// prefilled), the human approves in any browser, and the CLI polls until the
// grant is approved. The code lets the human confirm they are approving the
// sign-in they just started, the grant's phishing defence.

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresAt: number;
}

interface DeviceAuthorizeWire {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

export async function deviceAuthorize(
  authBaseUrl: string,
  now: number = Date.now(),
): Promise<DeviceAuthorization> {
  const body = new URLSearchParams({ app_id: CLI_APP_ID });
  let response: Response;
  try {
    response = await fetch(`${authBaseUrl}/device/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`Network error reaching ${authBaseUrl}: ${String(cause)}`);
  }
  if (!response.ok) throw new Error(`Device sign-in could not start (${response.status})`);
  const json = (await response.json()) as DeviceAuthorizeWire;
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    ...(json.verification_uri_complete
      ? { verificationUriComplete: json.verification_uri_complete }
      : {}),
    // Guard both fields the poll loop depends on. The server always sends
    // them, but a missing `interval` makes `sleep(NaN * 1000)` a zero-delay
    // tight poll of /device/token, and a missing `expires_in` makes the
    // `now() >= expiresAt` deadline check always false, so the loop never
    // times out. The token-exchange path already guards `expires_in` the same
    // way. RFC 8628 defaults: 5s poll interval, 600s grant lifetime.
    intervalSeconds: json.interval ?? 5,
    expiresAt: now + (json.expires_in ?? 600) * 1000,
  };
}

// One `/device/token` poll, classified into the four wire states a caller
// acts on. The blocking `pollDeviceToken` loop and the two-phase
// `brass login --check` both consume this, so the classification of the
// grant's wire states lives in one place.
export type DevicePollOutcome =
  | { state: 'approved'; tokens: RefreshedTokens }
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'denied' };

export async function pollDeviceTokenOnce(
  authBaseUrl: string,
  deviceCode: string,
  now: number = Date.now(),
): Promise<DevicePollOutcome> {
  const body = new URLSearchParams({ device_code: deviceCode, app_id: CLI_APP_ID });
  let response: Response;
  try {
    response = await fetch(`${authBaseUrl}/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    // A transient network error mid-poll: the device grant is still valid
    // server-side, so report "still pending" and let the caller poll again
    // rather than aborting a sign-in a retry would complete.
    // (`deviceAuthorize` / `postRefresh` guard their fetches the same way.)
    return { state: 'pending' };
  }
  const json = (await response.json().catch(() => ({}))) as Partial<RefreshWire> & {
    error?: string;
  };
  if (response.ok && json.access_token && json.id_token) {
    return {
      state: 'approved',
      tokens: {
        accessToken: json.access_token,
        idToken: json.id_token,
        expiresAt: now + tokenTtlSeconds(json.expires_in) * 1000,
        ...(json.session_token ? { sessionToken: json.session_token } : {}),
      },
    };
  }
  // The user declined: the one terminal refusal.
  if (json.error === 'access_denied') return { state: 'denied' };
  // RFC 8628 §3.5: polling too fast. The caller backs off.
  if (json.error === 'slow_down') return { state: 'slow_down' };
  // Everything else is "keep waiting": `authorization_pending`, a transient
  // non-2xx (5xx/429), a non-JSON body, or an error code this pinned CLI does
  // not recognize. The caller's deadline check is the single terminal bound,
  // so an unknown error or a server blip does not abort a sign-in the user is
  // one poll away from completing; a genuinely expired grant simply ends
  // there as a clean timeout.
  return { state: 'pending' };
}

// Poll `/device/token` until the grant is approved, or reject on denial /
// expiry. Honors the server-supplied interval; treats `authorization_pending`
// as "keep waiting".
export async function pollDeviceToken(
  authBaseUrl: string,
  auth: DeviceAuthorization,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<RefreshedTokens> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? ((): number => Date.now());
  // Server-supplied poll interval, bumped on `slow_down` per RFC 8628 §3.5.
  let intervalSeconds = auth.intervalSeconds;
  for (;;) {
    await sleep(intervalSeconds * 1000);
    if (now() >= auth.expiresAt) throw new Error('Device sign-in timed out. Run `brass login` again.');
    const outcome = await pollDeviceTokenOnce(authBaseUrl, auth.deviceCode, now());
    if (outcome.state === 'approved') return outcome.tokens;
    if (outcome.state === 'denied') throw new Error('Sign-in was denied.');
    if (outcome.state === 'slow_down') intervalSeconds += 5;
  }
}

export interface DeviceLoginOptions {
  authBaseUrl: string;
  // Shows the verification URL + user code to the human; defaults to stderr.
  onPrompt?: (auth: DeviceAuthorization) => void;
  // Opens the approval page (user code prefilled) in a browser; defaults to
  // the OS opener. A no-op on a headless box, where the printed URL + code is
  // the fallback.
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function loginDevice(options: DeviceLoginOptions): Promise<LoginResult> {
  const auth = await deviceAuthorize(options.authBaseUrl);
  (options.onPrompt ?? defaultDevicePrompt)(auth);
  (options.openBrowser ?? openBrowser)(auth.verificationUriComplete ?? auth.verificationUri);
  const tokens = await pollDeviceToken(
    options.authBaseUrl,
    auth,
    options.sleep ? { sleep: options.sleep } : {},
  );
  if (!tokens.sessionToken) throw new Error('Device sign-in did not return a session token.');
  return { sessionToken: tokens.sessionToken, email: decodeEmail(tokens.idToken) };
}

function defaultDevicePrompt(auth: DeviceAuthorization): void {
  const target = auth.verificationUriComplete ?? auth.verificationUri;
  process.stderr.write(
    '\nOpening your browser to approve this sign-in.\n' +
      `If it doesn't open, go to:\n  ${target}\n` +
      `and confirm the code:  ${auth.userCode}\n` +
      '\nWaiting for approval...\n',
  );
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    // A missing opener (`xdg-open` absent on a headless box) surfaces ENOENT
    // as an ASYNC 'error' event, not a throw; an unhandled one crashes the
    // process. Swallow it: the URL is already printed, so the user opens it
    // themselves.
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL was already printed; a failed auto-open is not fatal.
  }
}

// An auth provider backed by a stored login session: refresh the access
// token on first use and whenever it is within the skew window of expiry,
// caching it in memory for the process's lifetime.
export function sessionAuth(authBaseUrl: string, sid: string): AuthProvider {
  let cached: RefreshedTokens | null = null;
  const SKEW_MS = 60 * 1000;
  return {
    async headers() {
      if (cached === null || Date.now() >= cached.expiresAt - SKEW_MS) {
        cached = await postRefresh(authBaseUrl, sid);
      }
      return { authorization: `Bearer ${cached.accessToken}`, 'x-id-token': cached.idToken };
    },
  };
}
