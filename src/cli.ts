// Argv dispatch: resolve the target environment + credential, build the API
// client, and route to a command. Kept thin over `commands.ts` (which holds
// the workflow logic) so the wiring here is easy to read end to end.

import {
  parseArgs,
  stringFlag,
  boolFlag,
  unknownFlags,
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
import { readCredentialsFile, readPendingLogin, writeStoredCredential } from './store.js';
import { BrassApi, BrassApiError, type AppVisibility } from './api.js';
import { serviceTokenAuth, type AuthProvider } from './auth.js';
import { loginDevice, sessionAuth } from './session.js';
import { loginStart, loginCheck } from './login.js';
import { createLogger, type Logger } from './log.js';
import {
  publish,
  schemaPull,
  agentsPull,
  whoami,
  status,
  type CommandContext,
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
  brass logout               Forget the stored sign-in for this environment.
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

  if (boolFlag(parsed, 'version') && command === undefined) {
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

    const ctx = await buildContext(parsed);
    switch (command) {
      case 'publish':
        log.result(await runPublish(ctx, parsed));
        return 0;
      case 'schema':
        log.result(await runSchema(ctx, parsed));
        return 0;
      case 'agents':
        log.result(await runAgents(ctx, parsed));
        return 0;
      case 'whoami':
        log.result(await whoami(ctx));
        return 0;
      default:
        process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`);
    return 1;
  }
}

type Context = CommandContext;

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
  const { profile } = resolveBase(parsed);
  await writeStoredCredential(profile, null);
  log.success('Signed out.');
  log.result({ signed_out: true });
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

async function runPublish(ctx: Context, parsed: ParsedArgs): Promise<unknown> {
  const dir = parsed.positionals[1] ?? 'dist';
  const flagApp = stringFlag(parsed, 'app');
  const envApp = process.env['BRASS_APP_ID'];
  const name = stringFlag(parsed, 'name');
  const org = stringFlag(parsed, 'org');
  const slug = stringFlag(parsed, 'slug');
  const clientToken = stringFlag(parsed, 'client-token');
  const visibility = parseVisibilityFlag(stringFlag(parsed, 'visibility'));
  const requireAccess = parseGateFlag(stringFlag(parsed, 'gate'));
  const state = await readProjectState(ctx.cwd);
  const appId = resolveAppId({
    ...(flagApp !== undefined ? { flagApp } : {}),
    ...(envApp !== undefined ? { envApp } : {}),
    state,
    profile: ctx.profile,
  });
  return publish(ctx, {
    dir,
    manifestPath: stringFlag(parsed, 'manifest') ?? 'brass-app.json',
    ...(appId !== null ? { appId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(org !== undefined ? { organizationId: org } : {}),
    ...(clientToken !== undefined ? { clientToken } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(requireAccess !== undefined ? { requireAccess } : {}),
  });
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

async function runSchema(ctx: Context, parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];
  if (sub === 'pull') {
    const docId = stringFlag(parsed, 'doc');
    if (docId === undefined) throw new Error('brass schema pull requires --doc <docId>');
    return schemaPull(ctx, { docId, outPath: stringFlag(parsed, 'out') ?? 'brass-app.json' });
  }
  throw new Error('Usage: brass schema pull --doc <docId> [--out brass-app.json]');
}

async function runAgents(ctx: Context, parsed: ParsedArgs): Promise<unknown> {
  if (parsed.positionals[1] !== 'pull') {
    throw new Error(
      'Usage: brass agents pull [--out AGENTS.md | --stdout] [--org <organizationId>]',
    );
  }
  const org = stringFlag(parsed, 'org');
  return agentsPull(ctx, {
    outPath: stringFlag(parsed, 'out') ?? 'AGENTS.md',
    ...(boolFlag(parsed, 'stdout') ? { stdout: true } : {}),
    ...(org !== undefined ? { organizationId: org } : {}),
  });
}

function formatError(err: unknown): string {
  if (err instanceof BrassApiError) {
    if (err.status === 401) {
      return `error: ${err.message} (the credential was rejected; check BRASS_SERVICE_TOKEN or --token)`;
    }
    return `error: ${err.message}`;
  }
  if (err instanceof Error) return `error: ${err.message}`;
  return `error: ${String(err)}`;
}
