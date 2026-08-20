// The two-phase `brass login --start` / `brass login --check` flow, the
// agent-shaped variant of the blocking device grant. `--start` mints the
// grant, prints the approval URL + code, persists the grant, and exits, so a
// harness that cannot hold a long-running command can relay the URL to the
// human. `--check` reloads the grant and polls it, once by default or until a
// bounded `--wait` deadline. Both share `pollDeviceTokenOnce`'s classification
// with the blocking flow.
//
// The flow is built around one fact: the human approving is not watching the
// terminal, so the wait is open-ended while the grant is not. Every phase
// therefore keeps a live grant alive on its own rather than handing the
// caller a recovery step: `--start` resumes a grant that is still good instead
// of superseding the code already relayed, and a lapsed grant is replaced in
// place with a fresh one whose code is printed. A caller that has to relay a
// second code because the first expired is the cost being avoided.

import { deviceAuthorize, pollDeviceTokenOnce, postDeviceCancel, decodeEmail } from './session.js';
import {
  readPendingLogin,
  writePendingLogin,
  writeStoredCredential,
  type PendingLogin,
} from './store.js';
import type { Logger } from './log.js';
import type { Profile } from './config.js';

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A grant with less than this left is renewed rather than handed out, so a
// caller never relays a code that dies while the human is still reading it.
const MIN_USABLE_REMAINING_MS = 60_000;

export interface LoginStartOptions {
  authBaseUrl: string;
  profile: Profile;
  log: Logger;
  // Mint a fresh grant even when a usable one is pending (`--new`), for a
  // human who lost the relayed code.
  force?: boolean;
  // Set when a wait follows in the same command (`--start --wait`), whose own
  // terminal result is the one the caller reads. `--json` is one document per
  // run, so the started state prints to the human stream only.
  resultFollows?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

// Mint a device grant, persist it as the profile's pending sign-in, print
// the approval URL + user code, and exit without waiting. The browser is not
// opened: the human approving is often on a different machine, so the URL is
// printed for relaying.
export async function loginStart(options: LoginStartOptions): Promise<number> {
  const now = options.now ?? ((): number => Date.now());
  const env = options.env ?? process.env;
  // Resume a grant with usable time left. A second `--start` otherwise mints a
  // second code and forgets the first, so an approval the human is part-way
  // through completes a grant the CLI can no longer redeem and they are asked
  // to sign in again.
  const existing = await readPendingLogin(options.profile, env);
  const resumed =
    options.force !== true &&
    existing !== null &&
    existing.expiresAt - now() > MIN_USABLE_REMAINING_MS
      ? existing
      : null;
  // A superseded grant that is still live stays approvable on the server for
  // the rest of its TTL while this machine forgets the only copy of its
  // device code, so cancel it before the record is overwritten. Best-effort:
  // an undelivered cancel leaves a grant nobody can redeem from here, and the
  // new grant is the one this command is for.
  if (resumed === null && existing !== null && existing.expiresAt > now()) {
    await postDeviceCancel(existing.authBaseUrl, existing.deviceCode);
  }
  const pending = resumed ?? (await mintPendingLogin(options.authBaseUrl, now(), options.profile, env));
  promptFor(options.log, pending, {
    lead: resumed === null ? null : 'A sign-in is already waiting for approval.',
  });
  if (options.resultFollows !== true) {
    options.log.result({
      state: 'started',
      resumed: resumed !== null,
      verification_url: targetUrl(pending),
      user_code: pending.userCode,
      expires_at: pending.expiresAt,
      expires_in_seconds: remainingSeconds(pending, now()),
    });
  }
  return 0;
}

export interface LoginCheckOptions {
  profile: Profile;
  log: Logger;
  // Poll until approval for up to this many seconds instead of once
  // (`--wait`). A grant that lapses inside the window is renewed in place and
  // the new code printed, so the wait outlives any single grant.
  waitSeconds?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Poll the profile's pending grant. Approved stores the session exactly as the
// blocking flow does and clears the grant; denied clears it and exits nonzero.
// Expiry renews the grant in place and prints the new code. Without `--wait`
// this makes exactly one poll and reports what it saw; with it, it keeps
// polling until approval or the deadline, and a deadline reached with the
// grant still pending is a `pending` result, not a failure: the grant is
// alive and the next check resumes it.
export async function loginCheck(options: LoginCheckOptions): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? realSleep;
  const waitMs = Math.max(0, (options.waitSeconds ?? 0) * 1000);
  const deadline = now() + waitMs;

  let pending = await readPendingLogin(options.profile, env);
  if (pending === null) {
    options.log.info('No sign-in in progress. Run `brass login --start` first.');
    options.log.result({ state: 'none' });
    return 1;
  }
  let intervalSeconds = pending.intervalSeconds;
  // Set once the loop renews a lapsed grant, so the reported state tells the
  // caller a NEW code needs relaying rather than the one it already sent.
  let renewed = false;
  // Whether the grant's code has already been printed since the last poll, so
  // a renewal that is immediately followed by the closing report prints the
  // code once rather than twice.
  let justPrompted = false;

  for (;;) {
    if (now() >= pending.expiresAt) {
      pending = await mintPendingLogin(pending.authBaseUrl, now(), options.profile, env);
      intervalSeconds = pending.intervalSeconds;
      renewed = true;
      promptFor(options.log, pending, {
        lead: 'The previous code expired, so this sign-in has a new one.',
      });
      justPrompted = true;
    }

    const outcome = await pollDeviceTokenOnce(pending.authBaseUrl, pending.deviceCode, now());
    if (outcome.state === 'approved') {
      if (!outcome.tokens.sessionToken) {
        throw new Error('Device sign-in did not return a session token.');
      }
      await writeStoredCredential(
        options.profile,
        { session: { sid: outcome.tokens.sessionToken, authBaseUrl: pending.authBaseUrl } },
        env,
      );
      await writePendingLogin(options.profile, null, env);
      const email = decodeEmail(outcome.tokens.idToken);
      options.log.success(email !== undefined ? `Signed in as ${email}.` : 'Signed in.');
      options.log.result({ state: 'approved', ...(email !== undefined ? { email } : {}) });
      return 0;
    }
    if (outcome.state === 'denied') {
      await writePendingLogin(options.profile, null, env);
      options.log.info('Sign-in was denied. Run `brass login --start` to begin a new one.');
      options.log.result({ state: 'denied' });
      return 1;
    }
    // RFC 8628 §3.5: polling too fast. Back off for the rest of this wait.
    if (outcome.state === 'slow_down') intervalSeconds += 5;

    const nextPollAt = now() + intervalSeconds * 1000;
    if (nextPollAt > deadline) break;
    await sleep(intervalSeconds * 1000);
    justPrompted = false;
  }

  // Still pending: reprint the URL + code so the caller can relay them again.
  if (!justPrompted) {
    promptFor(options.log, pending, { lead: renewed ? null : 'Not approved yet.' });
  }
  options.log.result({
    state: renewed ? 'renewed' : 'pending',
    verification_url: targetUrl(pending),
    user_code: pending.userCode,
    expires_at: pending.expiresAt,
    expires_in_seconds: remainingSeconds(pending, now()),
  });
  return 0;
}

async function mintPendingLogin(
  authBaseUrl: string,
  now: number,
  profile: Profile,
  env: NodeJS.ProcessEnv,
): Promise<PendingLogin> {
  const auth = await deviceAuthorize(authBaseUrl, now);
  const pending: PendingLogin = {
    authBaseUrl,
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    ...(auth.verificationUriComplete !== undefined
      ? { verificationUriComplete: auth.verificationUriComplete }
      : {}),
    intervalSeconds: auth.intervalSeconds,
    expiresAt: auth.expiresAt,
  };
  await writePendingLogin(profile, pending, env);
  return pending;
}

function targetUrl(pending: PendingLogin): string {
  return pending.verificationUriComplete ?? pending.verificationUri;
}

function remainingSeconds(pending: PendingLogin, now: number): number {
  return Math.max(0, Math.round((pending.expiresAt - now) / 1000));
}

// The one rendering of "here is what to relay, and here is what to run next",
// so a resumed, renewed, and freshly minted grant all read the same to whoever
// is relaying it.
function promptFor(log: Logger, pending: PendingLogin, opts: { lead: string | null }): void {
  log.info(
    (opts.lead !== null ? `${opts.lead}\n` : '') +
      'To approve this sign-in, go to:\n' +
      `  ${targetUrl(pending)}\n` +
      `and confirm the code:  ${pending.userCode}\n` +
      '\nThen run `brass login --check --wait` to finish signing in.',
  );
}
