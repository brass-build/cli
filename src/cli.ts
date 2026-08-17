// Argv dispatch: resolve the target environment + credential, build the API
// client, and route to a command. Kept thin over `commands.ts` (which holds
// the workflow logic) so the wiring here is easy to read end to end.

import {
  parseArgs,
  stringFlag,
  boolFlag,
  extraPositionals,
  flagsNotReadBy,
  unknownFlags,
  valueFlagsOf,
  valuelessFlags,
  type ParsedArgs,
} from './args.js';
import {
  resolveOrigins,
  resolveCredential,
  profileForOrigins,
  type OriginOverrides,
  type Origins,
  type Profile,
} from './config.js';
import {
  readCredentialsFile,
  readPendingLogin,
  writePendingLogin,
  writeStoredCredential,
} from './store.js';
import { BrassApi, BrassApiError, type AppVisibility } from './api.js';
import { serviceTokenAuth, type AuthProvider } from './auth.js';
import { loginDevice, postDeviceCancel, postSignOut, sessionAuth } from './session.js';
import { loginStart, loginCheck } from './login.js';
import { createLogger, type Logger } from './log.js';
import {
  publish,
  schemaPull,
  agentsPull,
  whoami,
  status,
  type CommandContext,
  type CredentialKind,
} from './commands.js';
import { readProjectState, resolveAppId, readManifest } from './project.js';

import { VERSION } from './version.js';

export { VERSION };

const USAGE = `brass ${VERSION} - publish Brass apps and pull schemas

Usage:
  brass login                Sign in with your browser (opens the approval page; approve, done).
  brass login --start        Start a sign-in and exit: prints the approval URL + code to relay.
                             Resumes the code already waiting; --new forces a fresh one.
  brass login --check        Check a started sign-in once; stores the session when approved.
                             --wait [seconds] polls until approved (default 120s), renewing
                             an expired code in place and printing the new one.
  brass logout               End the stored sign-in for this environment, here and on the server.
  brass status [dir]         Report the credential + app state and the one command to run next.
  brass publish [dir]        Build output in [dir] (default: dist) is deployed to the app's hosting.
  brass schema pull --doc <docId> [--out brass-app.json]
                             Fetch a document's schema and write it into a manifest, verbatim.
  brass agents pull [--out AGENTS.md | --stdout] [--org <organizationId>]
                             Write your organization's agent instructions (its
                             AGENTS.md / CLAUDE.md) to a file, or --stdout to print
                             them (an agent reads them inline). Needs 'brass login';
                             --org is optional when you belong to one organization.
  brass whoami               Verify the current credential authenticates.

Authentication:
  Run 'brass login' to sign in with your browser (needed for schema pull),
  or set BRASS_SERVICE_TOKEN to a service token minted in the dashboard
  (org Settings -> Service tokens) for CI, or pass --token <token>.

Common flags:
  --token <token>            Service token to authenticate with.
  --json                     Emit the machine-readable result on stdout.

Publish flags:
  --app <appId>             Publish to a specific app (else .brass/project.json / BRASS_APP_ID).
  --name <name>             Name for the app when creating one on first publish.
  --org <organizationId>    Organization to own a newly created app (a signed-in user defaults to their own org; a service token to the token's org).
  --client-token <key>      Stable key that makes a first create idempotent (else brass-app.json "client_token").
  --slug <slug>             Preferred hosting subdomain on first enable.
  --visibility <v>          Set the app's visibility (private | invitee_visible | public).
  --gate <on|off>           Set the hosted load gate (on = audience-gated, off = world-loadable).
  --manifest <path>         Served manifest to read a create name from (default: brass-app.json).
`;

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const command = parsed.positionals[0];
  // Which credential the invocation resolved, once it has. A 401 is reported
  // in that credential's own vocabulary, so it stays undefined until
  // `buildContext` settles it and a failure before then carries no guess.
  let credentialKind: CredentialKind | undefined;

  // Answered whichever command follows, like `--help` beside it: both are
  // declared flags of every command (`COMMON_FLAGS`), so a caller who asks
  // which version is installed gets the answer rather than a publish.
  if (boolFlag(parsed, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === undefined || boolFlag(parsed, 'help') || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined && !boolFlag(parsed, 'help') ? 1 : 0;
  }

  // Checked after --help / --version so a caller reaching for usage still gets
  // it, and before any command runs so an unrecognised flag never reaches a
  // request. Ignoring one would silently target production, since that is what
  // the origin flags default to.
  const unknown = unknownFlags(parsed);
  if (unknown.length > 0) {
    const names = unknown.map((n) => `--${n}`).join(', ');
    process.stderr.write(`error: unknown ${unknown.length === 1 ? 'flag' : 'flags'} ${names}\n\n${USAGE}`);
    return 1;
  }

  // Then what THIS command reads, which is the same check one scope in: a
  // flag or a positional the command ignores leaves the run differing from
  // what the command line asked for, with nothing said. Judged from argv
  // alone, so it answers a caller who has not signed in.
  const misplaced = flagsNotReadBy(parsed, command);
  if (misplaced.length > 0) {
    const names = misplaced.map((n) => `--${n}`).join(', ');
    process.stderr.write(
      `error: ${names} ${misplaced.length === 1 ? 'is not a flag' : 'are not flags'} of \`brass ${command}\`\n\n${USAGE}`,
    );
    return 1;
  }
  const extra = extraPositionals(parsed, command);
  if (extra.length > 0) {
    const args = extra.map((p) => JSON.stringify(p)).join(', ');
    process.stderr.write(
      `error: unexpected ${extra.length === 1 ? 'argument' : 'arguments'} ${args} for \`brass ${command}\`\n\n${USAGE}`,
    );
    return 1;
  }
  if (parsed.valuedBooleans.length > 0) {
    const names = parsed.valuedBooleans.map((n) => `--${n}`).join(', ');
    process.stderr.write(
      `error: ${names} ${parsed.valuedBooleans.length === 1 ? 'takes' : 'take'} no value\n`,
    );
    return 1;
  }
  const bare = valuelessFlags(parsed, valueFlagsOf(command));
  if (bare.length > 0) {
    process.stderr.write(
      `error: Missing value for ${bare.map((n) => `--${n}`).join(', ')}\n`,
    );
    return 1;
  }

  const json = boolFlag(parsed, 'json');
  const log = createLogger(json);

  try {
    // login / logout run before any credential is required (login is how
    // one is obtained); everything else needs a resolved credential.
    if (command === 'login') return await runLogin(parsed, log);
    if (command === 'logout') return await runLogout(parsed, log);
    // status runs before a credential is required: reporting "no credential"
    // (and the next step to obtain one) is a first-class outcome, not an error.
    if (command === 'status') return await runStatus(parsed, log);

    // What the caller asked for is decided from argv alone, so it is decided
    // BEFORE a credential is resolved. A misspelt command, a missing
    // subcommand and an invalid flag value are all answerable without one, and
    // resolving the credential first answers every one of them with "No
    // credential. Run `brass login`": the caller re-authenticates over a typo,
    // and only a caller who already has a credential is ever shown the message
    // naming the real mistake.
    if (!isCredentialedCommand(command)) {
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
    }
    const plan = planCommand(command, parsed);

    const ctx = await buildContext(parsed);
    credentialKind = ctx.credentialKind;
    log.result(await plan(ctx));
    return 0;
  } catch (err) {
    process.stderr.write(`${formatError(err, credentialKind)}\n`);
    return 1;
  }
}

type Context = CommandContext;

// The commands that need a resolved credential; `login` / `logout` / `status`
// are answered above without one.
const CREDENTIALED_COMMANDS = ['publish', 'schema', 'agents', 'whoami'] as const;
type CredentialedCommand = (typeof CREDENTIALED_COMMANDS)[number];

function isCredentialedCommand(value: string): value is CredentialedCommand {
  return (CREDENTIALED_COMMANDS as readonly string[]).includes(value);
}

// The work a command will do once it has a credential.
type CommandPlan = (ctx: Context) => Promise<unknown>;

// Resolve argv to that work, validating everything argv alone decides and
// throwing on a shape the caller got wrong. Splitting the plan from the run is
// what lets the shape be judged before a credential is resolved.
function planCommand(command: CredentialedCommand, parsed: ParsedArgs): CommandPlan {
  switch (command) {
    case 'publish':
      return planPublish(parsed);
    case 'schema':
      return planSchema(parsed);
    case 'agents':
      return planAgents(parsed);
    case 'whoami':
      return (ctx): Promise<unknown> => whoami(ctx);
    default: {
      const exhaustive: never = command;
      throw new Error(`Unhandled command "${String(exhaustive)}"`);
    }
  }
}

interface Base {
  origins: Origins;
  profile: Profile;
}

// The flags that name the target stack. Production is the default, so every
// other stack is reached through these.
const ORIGIN_FLAGS = ['api-url', 'auth-url', 'dashboard-url'] as const;

// Resolve the target origins + profile from the origin flags, shared by every
// command (login and the credential-bearing ones).
function resolveBase(parsed: ParsedArgs): Base {
  const valueless = valuelessFlags(parsed, ORIGIN_FLAGS);
  if (valueless.length > 0) {
    throw new Error(`Missing value for ${valueless.map((name) => `--${name}`).join(', ')}`);
  }
  const overrides: OriginOverrides = {};
  const apiUrl = stringFlag(parsed, 'api-url');
  if (apiUrl !== undefined) overrides.apiBaseUrl = apiUrl;
  const authUrl = stringFlag(parsed, 'auth-url');
  if (authUrl !== undefined) overrides.authBaseUrl = authUrl;
  const dashUrl = stringFlag(parsed, 'dashboard-url');
  if (dashUrl !== undefined) overrides.dashboardBaseUrl = dashUrl;

  const origins = resolveOrigins(overrides);
  return { origins, profile: profileForOrigins(origins) };
}

async function buildContext(parsed: ParsedArgs): Promise<Context> {
  const { origins, profile } = resolveBase(parsed);
  const { auth, credentialKind } = await resolveAuth(parsed, origins, profile);
  return {
    api: new BrassApi(origins.apiBaseUrl, auth),
    cwd: process.cwd(),
    profile,
    credentialKind,
    log: createLogger(boolFlag(parsed, 'json')),
  };
}

// Build the request auth from the resolved credential: a service token is a
// static bearer; a login session refreshes short-lived access tokens. Returns
// the credential kind alongside, so a create can resolve the owning org from a
// human's membership but skip the lookup for a service token.
async function resolveAuth(
  parsed: ParsedArgs,
  origins: Origins,
  profile: Profile,
): Promise<{ auth: AuthProvider; credentialKind: 'service' | 'session' }> {
  const file = await readCredentialsFile();
  const flagToken = stringFlag(parsed, 'token');
  const envToken = process.env['BRASS_SERVICE_TOKEN'];
  const credential = resolveCredential({
    profile,
    ...(flagToken !== undefined ? { flagToken } : {}),
    ...(envToken !== undefined ? { envToken } : {}),
    ...(file !== null ? { file } : {}),
  });
  if (credential === null) {
    throw new Error(
      'No credential. Run `brass login`, or set BRASS_SERVICE_TOKEN (mint one in the dashboard: org Settings -> Service tokens), or pass --token.',
    );
  }
  const auth =
    credential.kind === 'service'
      ? serviceTokenAuth(credential.token)
      : sessionAuth(origins.authBaseUrl, credential.sid);
  return { auth, credentialKind: credential.kind };
}

async function runLogin(parsed: ParsedArgs, log: Logger): Promise<number> {
  const { origins, profile } = resolveBase(parsed);
  // The two-phase variant for automation: `--start` mints the grant and
  // exits; `--check` polls it. Plain `brass login` stays the blocking
  // interactive flow.
  const start = boolFlag(parsed, 'start');
  const check = boolFlag(parsed, 'check');
  const waitSeconds = parseWaitFlag(parsed);
  if (start && check) throw new Error('Pass one of --start or --check.');
  if (start) {
    const code = await loginStart({
      authBaseUrl: origins.authBaseUrl,
      profile,
      log,
      ...(boolFlag(parsed, 'new') ? { force: true } : {}),
      ...(waitSeconds !== undefined ? { resultFollows: true } : {}),
    });
    // `--start --wait` is the whole sign-in in one command: relay the code it
    // prints, then it holds for the approval up to the deadline.
    if (code !== 0 || waitSeconds === undefined) return code;
    return loginCheck({ profile, log, waitSeconds });
  }
  if (check) {
    return loginCheck({ profile, log, ...(waitSeconds !== undefined ? { waitSeconds } : {}) });
  }
  // The RFC 8628 device grant: open the approval page (code prefilled), print
  // the URL + code as a fallback for a headless box, and poll until approval.
  const result = await loginDevice({ authBaseUrl: origins.authBaseUrl });
  await writeStoredCredential(profile, { session: { sid: result.sessionToken } });
  log.success(result.email ? `Signed in as ${result.email}.` : 'Signed in.');
  log.result({ signed_in: true, ...(result.email !== undefined ? { email: result.email } : {}) });
  return 0;
}

async function runLogout(parsed: ParsedArgs, log: Logger): Promise<number> {
  const { origins, profile } = resolveBase(parsed);

  // Revoke on the server first, while the pointer is still readable. A
  // service token belongs to an organization and is revoked in the dashboard,
  // so only a stored session has anything to end here.
  const file = await readCredentialsFile();
  const stored = file?.credentials[profile]?.session?.sid;
  const signedOut = stored === undefined ? true : await postSignOut(origins.authBaseUrl, stored);

  // A started sign-in is redeemable by whoever holds the device code, and a
  // human may still approve it after this command returns, so cancelling it on
  // the server is what a sign-out owes. Dropping the local record alone would
  // leave the grant live and this machine unable to name it.
  const pending = await readPendingLogin(profile);
  const cancelled =
    pending === null ? true : await postDeviceCancel(origins.authBaseUrl, pending.deviceCode);

  await writeStoredCredential(profile, null);
  await writePendingLogin(profile, null);
  const revoked = signedOut && cancelled;

  // The local credential is gone either way, so say so, and name the part
  // that did not happen rather than reporting a clean sign-out over a
  // credential that still works.
  if (revoked) {
    log.success('Signed out.');
  } else {
    log.success(
      'Signed out on this machine. Brass could not be reached to revoke the sign-in, so run `brass logout` again when it is.',
    );
  }
  log.result({ signed_out: true, revoked });
  return 0;
}

async function runStatus(parsed: ParsedArgs, log: Logger): Promise<number> {
  const { origins, profile } = resolveBase(parsed);

  // Resolve the credential directly (not via `resolveAuth`, which throws when
  // none is found); a missing credential is a reported state here.
  const file = await readCredentialsFile();
  const flagToken = stringFlag(parsed, 'token');
  const envToken = process.env['BRASS_SERVICE_TOKEN'];
  const credential = resolveCredential({
    profile,
    ...(flagToken !== undefined ? { flagToken } : {}),
    ...(envToken !== undefined ? { envToken } : {}),
    ...(file !== null ? { file } : {}),
  });
  const api =
    credential === null
      ? null
      : new BrassApi(
          origins.apiBaseUrl,
          credential.kind === 'service'
            ? serviceTokenAuth(credential.token)
            : sessionAuth(origins.authBaseUrl, credential.sid),
        );

  // What `publish` would target: the same app-id and manifest-name resolution
  // it does, so the reported next step matches what actually runs.
  const cwd = process.cwd();
  const dir = parsed.positionals[1] ?? 'dist';
  const state = await readProjectState(cwd);
  const flagApp = stringFlag(parsed, 'app');
  const envApp = process.env['BRASS_APP_ID'];
  const appId = resolveAppId({
    ...(flagApp !== undefined ? { flagApp } : {}),
    ...(envApp !== undefined ? { envApp } : {}),
    state,
    profile,
  });
  const manifest = await readManifest(stringFlag(parsed, 'manifest') ?? 'brass-app.json');
  const manifestName =
    typeof manifest?.name === 'string' && manifest.name.trim() !== ''
      ? manifest.name.trim()
      : null;

  const pending = await readPendingLogin(profile);
  const result = await status({
    api,
    profile,
    log,
    credential,
    appId,
    manifestName,
    publishDir: dir,
    pendingLogin:
      pending === null
        ? null
        : {
            userCode: pending.userCode,
            verificationUrl: pending.verificationUriComplete ?? pending.verificationUri,
            expiresAt: pending.expiresAt,
          },
  });
  log.result(result);
  return 0;
}

function planPublish(parsed: ParsedArgs): CommandPlan {
  const dir = parsed.positionals[1] ?? 'dist';
  const flagApp = stringFlag(parsed, 'app');
  const envApp = process.env['BRASS_APP_ID'];
  const name = stringFlag(parsed, 'name');
  const org = stringFlag(parsed, 'org');
  const slug = stringFlag(parsed, 'slug');
  const clientToken = stringFlag(parsed, 'client-token');
  const manifestPath = stringFlag(parsed, 'manifest') ?? 'brass-app.json';
  const visibility = parseVisibilityFlag(stringFlag(parsed, 'visibility'));
  const requireAccess = parseGateFlag(stringFlag(parsed, 'gate'));
  return async (ctx): Promise<unknown> => {
    const state = await readProjectState(ctx.cwd);
    const appId = resolveAppId({
      ...(flagApp !== undefined ? { flagApp } : {}),
      ...(envApp !== undefined ? { envApp } : {}),
      state,
      profile: ctx.profile,
    });
    return publish(ctx, {
      dir,
      manifestPath,
      ...(appId !== null ? { appId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(org !== undefined ? { organizationId: org } : {}),
      ...(clientToken !== undefined ? { clientToken } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(requireAccess !== undefined ? { requireAccess } : {}),
    });
  };
}

// How long `--wait` holds for the approval: bare `--wait` takes the default,
// `--wait <seconds>` an explicit bound. Capped so a mistyped value cannot
// park an automated caller for hours; the grant survives the cap either way,
// so a second check resumes the same sign-in.
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 3600;

function parseWaitFlag(parsed: ParsedArgs): number | undefined {
  const raw = parsed.flags['wait'];
  if (raw === undefined) return undefined;
  if (raw === true) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_WAIT_SECONDS) {
    throw new Error(`Invalid --wait "${raw}" (expected whole seconds, 1 to ${MAX_WAIT_SECONDS})`);
  }
  return seconds;
}

// Validate `--visibility` against the three reserved values, so a typo is a
// clear CLI error rather than a server 400 mid-publish.
function parseVisibilityFlag(value: string | undefined): AppVisibility | undefined {
  if (value === undefined) return undefined;
  if (value !== 'private' && value !== 'invitee_visible' && value !== 'public') {
    throw new Error(
      `Invalid --visibility "${value}" (expected private, invitee_visible, or public)`,
    );
  }
  return value;
}

// Map `--gate on|off` to the desired load-gate state (on = audience-gated).
function parseGateFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'on' && value !== 'off') {
    throw new Error(`Invalid --gate "${value}" (expected on or off)`);
  }
  return value === 'on';
}

function planSchema(parsed: ParsedArgs): CommandPlan {
  if (parsed.positionals[1] !== 'pull') {
    throw new Error('Usage: brass schema pull --doc <docId> [--out brass-app.json]');
  }
  const docId = stringFlag(parsed, 'doc');
  if (docId === undefined) throw new Error('brass schema pull requires --doc <docId>');
  const outPath = stringFlag(parsed, 'out') ?? 'brass-app.json';
  return (ctx): Promise<unknown> => schemaPull(ctx, { docId, outPath });
}

function planAgents(parsed: ParsedArgs): CommandPlan {
  if (parsed.positionals[1] !== 'pull') {
    throw new Error(
      'Usage: brass agents pull [--out AGENTS.md | --stdout] [--org <organizationId>]',
    );
  }
  // Both flags claim stdout: `--stdout` puts the instructions there verbatim,
  // `--json` the result object. Together they interleave two payloads on one
  // stream, so a caller parsing either reads the other's bytes as part of it.
  if (boolFlag(parsed, 'stdout') && boolFlag(parsed, 'json')) {
    throw new Error(
      'Pass one of --stdout or --json: both write to stdout, so together neither is parseable.',
    );
  }
  const org = stringFlag(parsed, 'org');
  const options = {
    outPath: stringFlag(parsed, 'out') ?? 'AGENTS.md',
    ...(boolFlag(parsed, 'stdout') ? { stdout: true } : {}),
    ...(org !== undefined ? { organizationId: org } : {}),
  };
  return (ctx): Promise<unknown> => agentsPull(ctx, options);
}

// Render a failure for the terminal, naming the fix for a 401 in the
// vocabulary of the credential that was actually rejected. A session's
// refusal already arrives carrying `brass login` (the refresh authors it), so
// appending a service-token hint there tells the caller to check an
// environment variable they never set, next to the sentence naming the real
// fix. `status` classifies the same 401 the same way.
function formatError(err: unknown, credentialKind?: CredentialKind): string {
  if (err instanceof BrassApiError) {
    if (err.status === 401 && credentialKind !== 'session') {
      return `error: ${err.message} (the credential was rejected; check BRASS_SERVICE_TOKEN or --token)`;
    }
    return `error: ${err.message}`;
  }
  if (err instanceof Error) return `error: ${err.message}`;
  return `error: ${String(err)}`;
}
