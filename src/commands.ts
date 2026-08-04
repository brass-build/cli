// The command implementations, each taking an already-authenticated
// `BrassApi` plus its inputs and returning a structured result (or throwing
// `BrassApiError` / `Error`). The bin layer wires real IO; tests drive these
// directly against a mocked client, including the full publish sequence.

import {
  BrassApi,
  BrassApiError,
  type AppDetail,
  type AppVisibility,
  type HostingStatus,
  type HostingUploadUrl,
  type HostingVersion,
  type HostingVersionStatus,
  type RefreshCapabilitiesResponse,
  type DocumentStreams,
  type DocumentTypeSummary,
  type AgentInstructionsResponse,
  type OrganizationSummary,
  putPresigned,
} from './api.js';
import type { Logger } from './log.js';
import type { Profile, ResolvedCredential } from './config.js';
import {
  mergeSchemaIntoManifest,
  readManifest,
  writeManifest,
  writeProjectAppId,
  writeTextFile,
  collectZipEntries,
  contentHash,
  zipEntries,
  isDirectory,
  type AppManifest,
} from './project.js';
import { basename } from 'node:path';

export interface CommandContext {
  api: BrassApi;
  cwd: string;
  // The credential/state key for this invocation (`prod` / `dev` /
  // `origin:<host>`).
  profile: string;
  // The kind of credential this invocation authenticates with. A `publish`
  // create resolves the owning org from the caller's single membership for a
  // human `session`; a `service` token binds to its own org server-side, so
  // no org lookup is needed there.
  credentialKind: CredentialKind;
  log: Logger;
}

export interface PublishOptions {
  // Directory of the built static bundle to upload.
  dir: string;
  // Resolved app id, or undefined to create a fresh app on first publish.
  appId?: string;
  // Name for a first-create when there is no app yet and the manifest has none.
  name?: string;
  // The organization a first-create app is owned by. Optional: a signed-in
  // human defaults to their single org (and is asked to choose when they have
  // several); a service token defaults to the token's own org. Every app is
  // owned by an org, so a create always resolves one.
  organizationId?: string;
  // A stable idempotency key for a first create, so repeated create-from-
  // scratch runs resolve the same app instead of duplicating. Overrides the
  // manifest's `client_token`.
  clientToken?: string;
  // Set the app's visibility (default `private`). `public` publishes a
  // showcase any signed-in user can list and open.
  visibility?: AppVisibility;
  // Desired hosted load-gate state. `true` gates the bundle behind the app's
  // audience; `false` makes it world-loadable (an open showcase). Absent
  // leaves the current state (the gate defaults on at first enable).
  requireAccess?: boolean;
  // Preferred hosting subdomain on first enable.
  slug?: string;
  // Path to the served manifest, read for a create `name` / `client_token`.
  manifestPath: string;
  // Polling knobs (defaulted); overridable so tests don't wait on wall clock.
  pollAttempts?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublishResult {
  app_id: string;
  version_id: string;
  url: string | null;
  // What the platform read back from the published manifest and wants the
  // publisher to act on (a schema missing `family`, an `x-brass-` keyword the
  // installed client does not implement). Carried in the RESULT as well as on
  // stderr, because `--json` is how a script or a coding agent publishes and
  // parsing prose out of a log is not something to ask of them. Empty when
  // the manifest reads clean.
  warnings: string[];
}

const DEFAULT_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function publish(ctx: CommandContext, opts: PublishOptions): Promise<PublishResult> {
  if (!(await isDirectory(opts.dir))) {
    throw new Error(`Publish directory not found: ${opts.dir}`);
  }

  const resolved = await resolveOrCreateApp(ctx, opts);
  const appId = resolved.appId;
  if (opts.visibility !== undefined) {
    await ensureVisibility(ctx, appId, opts.visibility, resolved.detail?.visibility);
  }
  const hosting = await ensureHosting(ctx, appId, opts.slug);
  if (opts.requireAccess !== undefined) {
    await ensureGate(ctx, appId, opts.requireAccess, hosting);
  }

  const entries = await collectZipEntries(opts.dir);
  if (Object.keys(entries).length === 0) {
    throw new Error(`No files found to publish under ${opts.dir}`);
  }
  const hash = contentHash(entries);

  // Skip the upload + unpack-wait when the app already serves this exact
  // bundle. The posture reconcile above still ran, so an unchanged re-publish
  // converges visibility / gate / slug and returns the live URL for the price
  // of a couple of reads instead of an upload and a poll loop.
  const unchanged = await activeVersionMatches(ctx, appId, hash);
  if (unchanged !== null) {
    const status = await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`);
    ctx.log.success(`Already up to date${status.url ? `: ${status.url}` : ''}`);
    // Refreshed here too, so publishing twice says the same thing both times.
    // A publisher acting on a warning re-runs publish to check, and a signal
    // that appears only on the run that happened to upload reads as fixed.
    const warnings = await refreshCapabilities(ctx, appId);
    return { app_id: appId, version_id: unchanged.version_id, url: status.url, warnings };
  }

  ctx.log.info('Packaging the bundle...');
  const bundle = zipEntries(entries);

  ctx.log.info('Uploading...');
  const upload = await ctx.api.post<HostingUploadUrl>(
    `/apps/${encodeURIComponent(appId)}/hosting/upload-url`,
    { content_hash: hash },
  );
  await putPresigned(upload.upload_url, bundle, 'application/zip');

  const completed = await ctx.api.post<HostingVersion>(
    `/apps/${encodeURIComponent(appId)}/hosting/versions/${encodeURIComponent(upload.version_id)}/complete`,
    {},
  );

  const version = await waitForVersion(ctx, appId, completed, opts);
  // Only an explicit `ready` is success. `waitForVersion` returns solely on a
  // terminal status (or throws on timeout), so a `!== 'ready'` here is `failed`
  // (or a future terminal-failure status): treat it as a failed deploy rather
  // than falling through to a success the CLI would report with exit 0.
  if (version.status !== 'ready') {
    throw new Error(`Deploy failed: ${version.failure_reason ?? 'unknown reason'}`);
  }

  // Best-effort: the platform crawls the served manifest after a deploy on
  // its own, but an explicit refresh surfaces capability warnings (e.g. a
  // schema missing `family`) right here instead of silently later.
  const warnings = await refreshCapabilities(ctx, appId);

  const status = await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`);
  if (status.url) ctx.log.success(`Deployed: ${status.url}`);
  return { app_id: appId, version_id: version.version_id, url: status.url, warnings };
}

async function resolveOrCreateApp(
  ctx: CommandContext,
  opts: PublishOptions,
): Promise<{ appId: string; detail?: AppDetail }> {
  if (opts.appId !== undefined) return { appId: opts.appId };
  const manifest = await readManifest(opts.manifestPath);
  const name = opts.name ?? manifest?.name;
  if (name === undefined || name.trim() === '') {
    throw new Error(
      'No app to publish to. Pass --name to create one, or --app / BRASS_APP_ID / a .brass/project.json for an existing app.',
    );
  }
  // A `client_token` makes create idempotent, so a repeated create-from-
  // scratch (ephemeral CI has no persisted project.json) resolves the same
  // app rather than minting a duplicate.
  const clientToken = opts.clientToken ?? manifest?.client_token;
  const organizationId = await resolveCreateOrganizationId(ctx, opts.organizationId);
  const body: { name: string; organization_id?: string; client_token?: string } = {
    name: name.trim(),
  };
  if (organizationId !== undefined) body.organization_id = organizationId;
  if (typeof clientToken === 'string' && clientToken.trim() !== '') {
    body.client_token = clientToken.trim();
  }
  const app = await ctx.api.post<AppDetail>('/apps', body);
  await writeProjectAppId(ctx.cwd, ctx.profile, app.app_id);
  // With a key the call resolves-or-creates, so avoid asserting it was new.
  ctx.log.info(
    `${body.client_token !== undefined ? 'Using' : 'Created'} app ${app.app_id} (saved to .brass/project.json)`,
  );
  return { appId: app.app_id, detail: app };
}

// Set the app's visibility when `--visibility` asks for one it does not
// already hold. `current` is the value from the create/resolve response when
// known; otherwise the app is read to avoid a redundant write (and the audit
// event a no-op change would emit) on every re-publish.
async function ensureVisibility(
  ctx: CommandContext,
  appId: string,
  want: AppVisibility,
  current: AppVisibility | undefined,
): Promise<void> {
  let have = current;
  if (have === undefined) {
    const detail = await ctx.api.get<AppDetail>(`/apps/${encodeURIComponent(appId)}`);
    have = detail.visibility;
  }
  if (have === want) return;
  await ctx.api.patch<AppDetail>(`/apps/${encodeURIComponent(appId)}`, { visibility: want });
  ctx.log.info(`Set visibility to ${want}.`);
}

// Converge the hosted load gate to `want` (`true` = gated to the audience,
// `false` = world-loadable). Always PATCH, even when the DDB flag already
// reads `want`: the PATCH is what reaches the server-side reconcile that
// repairs a wedged edge marker (a prior toggle whose flag write landed but
// whose marker write lost every ETag race leaves the flag reading correct
// while the marker disagrees). Skipping the PATCH on a matching flag would
// leave such a gate wedged forever, since every later publish would skip it
// too. `status` is the state `ensureHosting` just observed, used only to word
// the log line. (`require_access` absent === off.)
async function ensureGate(
  ctx: CommandContext,
  appId: string,
  want: boolean,
  status: HostingStatus,
): Promise<void> {
  const changed = (status.require_access === true) !== want;
  await ctx.api.patch<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`, {
    require_access: want,
  });
  if (changed) {
    ctx.log.info(
      want ? 'Enabled the load gate.' : 'Disabled the load gate (bundle is world-loadable).',
    );
  } else {
    ctx.log.info(want ? 'Load gate is on.' : 'Load gate is off (bundle is world-loadable).');
  }
}

async function ensureHosting(
  ctx: CommandContext,
  appId: string,
  slug?: string,
): Promise<HostingStatus> {
  const status = await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`);
  if (status.enabled) return status;
  const body: { slug?: string } = {};
  if (slug !== undefined) body.slug = slug;
  const enabled = await ctx.api.post<HostingStatus>(
    `/apps/${encodeURIComponent(appId)}/hosting`,
    body,
  );
  if (enabled.slug) ctx.log.info(`Enabled hosting at ${enabled.slug}`);
  return enabled;
}

// The currently-served version when it is `ready` and already carries
// `hash`, else null. A null (no active version, a non-ready active version, or
// a hash mismatch) means `publish` must upload. A first deploy has no active
// version, so it always uploads; a version predating content hashing has no
// recorded hash and so never matches, forcing one re-upload that self-heals.
async function activeVersionMatches(
  ctx: CommandContext,
  appId: string,
  hash: string,
): Promise<HostingVersion | null> {
  const { versions } = await ctx.api.get<{ versions: HostingVersion[] }>(
    `/apps/${encodeURIComponent(appId)}/hosting/versions`,
  );
  const active = versions.find((v) => v.active);
  if (active && active.status === 'ready' && active.content_hash === hash) return active;
  return null;
}

// Poll until the version reaches a KNOWN terminal state (`ready` / `failed`),
// then return it; time out otherwise. Deliberately loops while the status is
// anything other than a known terminal — `pending` OR any status this pinned
// CLI does not recognize — rather than returning on `!== 'pending'`. That way
// a future server status (a finer-grained non-terminal like `unpacking`, or a
// new terminal-failure like `rejected`) is not mistaken for "done": an
// unrecognized non-terminal keeps polling, and an unrecognized terminal
// failure ends as a timeout (a non-zero exit) instead of a false success.
function isTerminalVersionStatus(status: HostingVersionStatus): boolean {
  return status === 'ready' || status === 'failed';
}

async function waitForVersion(
  ctx: CommandContext,
  appId: string,
  completed: HostingVersion,
  opts: PublishOptions,
): Promise<HostingVersion> {
  if (isTerminalVersionStatus(completed.status)) return completed;
  const attempts = opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const { versions } = await ctx.api.get<{ versions: HostingVersion[] }>(
      `/apps/${encodeURIComponent(appId)}/hosting/versions`,
    );
    const current = versions.find((v) => v.version_id === completed.version_id);
    if (current && isTerminalVersionStatus(current.status)) return current;
  }
  throw new Error('Timed out waiting for the deploy to finish unpacking.');
}

async function refreshCapabilities(
  ctx: CommandContext,
  appId: string,
): Promise<string[]> {
  try {
    const refreshed = await ctx.api.post<RefreshCapabilitiesResponse>(
      `/apps/${encodeURIComponent(appId)}/capabilities/refresh`,
      {},
    );
    const warnings = refreshed.warnings ?? [];
    for (const warning of warnings) ctx.log.warn(warning);
    return warnings;
  } catch (err) {
    // A capability refresh is a convenience read on top of the deploy; the
    // platform re-crawls the manifest regardless, so a transient failure
    // here must not fail an otherwise-successful publish.
    const detail = err instanceof BrassApiError ? err.message : String(err);
    const warning = `Could not read capabilities yet: ${detail}`;
    ctx.log.warn(warning);
    return [warning];
  }
}

export interface SchemaPullOptions {
  docId: string;
  // Manifest to write the pulled `schema` into (created if absent).
  outPath: string;
}

export interface SchemaPullResult {
  family: string;
  out_path: string;
}

export async function schemaPull(
  ctx: CommandContext,
  opts: SchemaPullOptions,
): Promise<SchemaPullResult> {
  const docPath = `/documents/${encodeURIComponent(opts.docId)}`;
  const [held, summary] = await Promise.all([
    ctx.api.get<DocumentStreams>(`${docPath}/schema`),
    ctx.api.get<DocumentTypeSummary>(docPath),
  ]);
  // An app manifest is a CLAIM the developer is about to author: a family
  // plus a body per stream. The document holds no such thing, only streams,
  // so the manifest is ASSEMBLED here rather than read off the document.
  // Each published body goes in verbatim; the family is the document's own
  // type, the same token open-routing matches on. A stream the document
  // holds with no published contract is left out: a manifest entry is a
  // shape the app declares it works with, and there is no shape to declare.
  const family = summary.schema_type ?? '';
  if (family === '') {
    throw new Error(
      `Document ${opts.docId} carries no type, so there is no family to declare. Pull from a document an importer or app produced.`,
    );
  }
  const streams: Record<string, Record<string, unknown>> = {};
  for (const entry of held.streams) {
    if (entry.schema !== undefined) streams[entry.name] = entry.schema;
  }
  const manifest: AppManifest = (await readManifest(opts.outPath)) ?? {};
  await writeManifest(
    opts.outPath,
    mergeSchemaIntoManifest(manifest, { family, streams }),
  );
  ctx.log.success(`Wrote the "${family}" schema to ${opts.outPath}`);
  return { family, out_path: opts.outPath };
}

export interface AgentsPullOptions {
  // The org whose instructions to pull. Optional: when the caller belongs to
  // exactly one org it is resolved automatically; otherwise it is required.
  organizationId?: string;
  // File to write the instructions to (default `AGENTS.md`). Ignored when
  // `stdout` is set.
  outPath: string;
  // Print the body to stdout instead of writing a file: the always-fetch
  // path, where an agent reads the instructions inline and caches nothing.
  // Status still goes to stderr, so stdout carries only the instructions.
  stdout?: boolean;
}

export interface AgentsPullResult {
  organization_id: string;
  // The file written, or null in `--stdout` mode (nothing was written).
  out_path: string | null;
  bytes: number;
  // True when the org has no instructions set: nothing is written / printed.
  empty: boolean;
}

// Pull an organization's agentic-coding instructions (its AGENTS.md /
// CLAUDE.md body). Needs a human sign-in (`brass login`): the instructions
// read is org-membership gated, which a service token does not carry.
// Resolves the org from the caller's single membership when `--org` is
// omitted. The body is emitted verbatim, so it round-trips byte-for-byte with
// what the dashboard stored, either to a file (default) or to stdout
// (`--stdout`, for an agent that reads it inline and caches nothing).
export async function agentsPull(
  ctx: CommandContext,
  opts: AgentsPullOptions,
): Promise<AgentsPullResult> {
  const organizationId =
    opts.organizationId ?? (await resolveSingleOrganization(ctx));
  const instructions = await ctx.api.get<AgentInstructionsResponse>(
    `/organizations/${encodeURIComponent(organizationId)}/agent-instructions`,
  );
  const bytes = Buffer.byteLength(instructions.content, 'utf8');
  const empty = instructions.content === '';

  if (opts.stdout) {
    // Body straight to stdout (verbatim); an empty org prints nothing so a
    // consumer reads an empty stream, with the reason on stderr.
    if (empty) ctx.log.warn(`No agent instructions set for ${organizationId}.`);
    else ctx.log.write(instructions.content);
    return { organization_id: organizationId, out_path: null, bytes, empty };
  }

  if (empty) {
    ctx.log.warn(
      `No agent instructions set for ${organizationId}. Nothing written.`,
    );
    return { organization_id: organizationId, out_path: opts.outPath, bytes, empty: true };
  }
  await writeTextFile(opts.outPath, instructions.content);
  ctx.log.success(`Wrote agent instructions to ${opts.outPath} (${bytes} bytes)`);
  // Claude Code reads CLAUDE.md, not AGENTS.md (the cross-agent default this
  // writes). Point the user at the official one-line bridge so the pulled
  // instructions are actually picked up there; skip it when they already
  // pulled straight to a CLAUDE.md.
  const outName = basename(opts.outPath);
  if (outName.toLowerCase() !== 'claude.md') {
    ctx.log.info(
      `Claude Code reads CLAUDE.md, not ${outName}. To use these there, add a CLAUDE.md containing "@${outName}".`,
    );
  }
  return {
    organization_id: organizationId,
    out_path: opts.outPath,
    bytes,
    empty: false,
  };
}

async function listCallerOrganizations(
  ctx: CommandContext,
): Promise<OrganizationSummary[]> {
  const { organizations } = await ctx.api.get<{
    organizations: OrganizationSummary[];
  }>('/organizations');
  return organizations;
}

// Resolve the caller's single organization, or throw guidance to pass
// `--org`. A caller with zero orgs (or a service-token credential, which
// lists none) also gets a clear message rather than an opaque request error.
async function resolveSingleOrganization(ctx: CommandContext): Promise<string> {
  const organizations = await listCallerOrganizations(ctx);
  if (organizations.length === 1 && organizations[0] !== undefined) {
    return organizations[0].organization_id;
  }
  if (organizations.length === 0) {
    throw new Error(
      'No organizations for this credential. Pass --org <organizationId>, and sign in with `brass login` (agent instructions need a member sign-in, not a service token).',
    );
  }
  const names = organizations
    .map((o) => `${o.organization_id} (${o.name})`)
    .join(', ');
  throw new Error(
    `Multiple organizations; pass --org <organizationId>. Available: ${names}`,
  );
}

// The owning org for a first `publish` create. Every app is owned by an org.
// An explicit `--org` wins. A signed-in human resolves to their single
// membership (asked to choose when they belong to several, or to create/join
// one when they have none). A service token returns undefined: the API binds
// the app to the token's own org, and the token lists no memberships anyway.
async function resolveCreateOrganizationId(
  ctx: CommandContext,
  explicit: string | undefined,
): Promise<string | undefined> {
  if (explicit !== undefined) return explicit;
  if (ctx.credentialKind !== 'session') return undefined;
  const organizations = await listCallerOrganizations(ctx);
  if (organizations.length === 1 && organizations[0] !== undefined) {
    const orgId = organizations[0].organization_id;
    ctx.log.info(
      `Owning organization ${orgId} (your only one; pass --org to choose another).`,
    );
    return orgId;
  }
  if (organizations.length === 0) {
    throw new Error(
      'You do not belong to any organization, so there is nothing to own the app. Create or join one in the dashboard, then publish.',
    );
  }
  const names = organizations
    .map((o) => `${o.organization_id} (${o.name})`)
    .join(', ');
  throw new Error(
    `You belong to multiple organizations; pass --org <organizationId> to choose which one owns the app. Available: ${names}`,
  );
}

export interface WhoamiResult {
  authenticated: true;
}

// Confirm the resolved credential authenticates, over the `apps:write`-gated
// probe (`GET /health`) both credential kinds can reach: a service token is an
// org-scoped identity that enumerates no membership, so it has no org id to
// address an org-scoped read with. A 401 (rejected credential) or 403 (a token
// without the publish capability) surfaces as a thrown BrassApiError the CLI
// turns into a non-zero exit.
export async function whoami(ctx: CommandContext): Promise<WhoamiResult> {
  await ctx.api.get<{ ok: true }>('/health');
  ctx.log.success('Authenticated. This credential can publish.');
  return { authenticated: true };
}

export type CredentialKind = 'none' | 'service' | 'session';

export interface StatusInputs {
  // The API client for the resolved credential, or null when there is no
  // credential to probe with (status still reports "no credential" then).
  api: BrassApi | null;
  profile: Profile;
  log: Logger;
  credential: ResolvedCredential | null;
  // The app id `publish` would target (resolved from --app / BRASS_APP_ID /
  // .brass/project.json), or null when a first publish would create one.
  appId: string | null;
  // A create name available for a first publish (from brass-app.json), so the
  // next-step command can name what it will create.
  manifestName: string | null;
  // The directory `publish` would upload, for the emitted next-step command.
  publishDir: string;
  // A device grant `brass login --start` minted that no one has approved yet.
  // Reporting it (and how long it has left) is what lets a caller tell a
  // sign-in that is still relayable from one it has to restart, which is the
  // difference between waiting and asking the human for a second approval.
  pendingLogin: { userCode: string; verificationUrl: string; expiresAt: number } | null;
}

export interface StatusResult {
  profile: string;
  signed_in: boolean;
  credential: CredentialKind;
  // True once a probe confirms the credential authenticates; false when it is
  // rejected; null when the probe could not settle the question (there was no
  // credential to probe, or the probe itself failed).
  authenticated: boolean | null;
  // What stopped the probe from settling it, when `authenticated` is null and
  // a credential was present. Kept separate from `authenticated` so a reader
  // acts on the actual failure rather than on a guess at its cause.
  unverified_reason?: string;
  email: string | null;
  // The sign-in awaiting approval, if one is in flight, with the seconds it
  // has left. A caller polls `brass login --check` against this rather than
  // starting a second sign-in.
  pending_login: {
    user_code: string;
    verification_url: string;
    expires_in_seconds: number;
  } | null;
  app_id: string | null;
  hosting: { enabled: boolean; deployed: boolean; url: string | null } | null;
  // Whether the state is such that a `publish` would proceed (a credential
  // that authenticates, and either a resolvable app or a create name).
  ready_to_publish: boolean;
  // The single imperative next action, as a command where one applies. This is
  // the field an agent acts on: it names the next step rather than describing
  // how publishing works.
  next: string;
}

// Report the publish readiness of the current directory + credential and,
// crucially, the one command to run next. `whoami` answers "does my token
// work"; `status` answers "what do I do now", so an agent follows its output
// instead of re-deriving the publish flow from prose under friction. It never
// throws on a missing or rejected credential: those are first-class states it
// reports and turns into a next step, not errors.
export async function status(inp: StatusInputs): Promise<StatusResult> {
  const publishCmd = `brass publish ./${inp.publishDir}`;
  const kind: CredentialKind = inp.credential === null ? 'none' : inp.credential.kind;

  // No credential yet. Only the human can approve, but starting the sign-in,
  // relaying the code, and polling it through are the caller's steps, so the
  // next line names the command to run rather than an instruction to pass on.
  if (inp.api === null || inp.credential === null) {
    const pending = inp.pendingLogin;
    return finish(inp, {
      signed_in: false,
      credential: 'none',
      authenticated: null,
      email: null,
      hosting: null,
      ready_to_publish: false,
      next:
        pending !== null
          ? `a sign-in for ${inp.profile} is waiting for approval: give the user ` +
            `${pending.verificationUrl} and the code ${pending.userCode}, then run ` +
            `'brass login --check --wait'. It polls until they approve and renews ` +
            `the code if it lapses, so there is no need to start a second sign-in.`
          : `no credential for ${inp.profile}. Run 'brass login --start' to begin a ` +
            `sign-in, give the user the URL and short code it prints, then run ` +
            `'brass login --check --wait' until it reports approved (or set ` +
            `BRASS_SERVICE_TOKEN). The session feeds the build steps ` +
            `('brass agents pull' for the organization's instructions, ` +
            `'brass schema pull' for your example document's schema) as well as ` +
            `the eventual '${publishCmd}'.`,
    });
  }

  // Probe the credential against the live API (the same read a publish makes),
  // so "signed in" means verified, not just "a token is present".
  const probe = await probeAuth(inp.api);
  if (probe.state === 'unreachable' || probe.state === 'fault') {
    return finish(inp, {
      signed_in: false,
      credential: kind,
      authenticated: null,
      unverified_reason: probe.error,
      email: null,
      hosting: null,
      ready_to_publish: false,
      next:
        probe.state === 'unreachable'
          ? `could not reach the Brass API (${probe.error}). Check connectivity, ` +
            `then run 'brass status' again.`
          : `the Brass API answered, but the credential could not be verified ` +
            `(${probe.error}). The credential was not rejected and the API is ` +
            `reachable, so run 'brass status' again.`,
    });
  }
  if (probe.state === 'rejected') {
    return finish(inp, {
      signed_in: false,
      credential: kind,
      authenticated: false,
      email: null,
      hosting: null,
      ready_to_publish: false,
      next:
        kind === 'session'
          ? `the stored sign-in was rejected. Run 'brass login --start' to begin a ` +
            `new one, relay the printed URL + code, then 'brass login --check --wait'.`
          : `the service token was rejected. Check BRASS_SERVICE_TOKEN or --token.`,
    });
  }

  const email = kind === 'session' ? await probeEmail(inp.api) : null;

  // Verified. What would `publish` target? A service token's create binds to
  // the token's own org by default, so no `--org` is needed to stand one up.
  if (inp.appId === null) {
    const next =
      inp.manifestName !== null
        ? `signed in. No app yet; run '${publishCmd}' to create ` +
          `"${inp.manifestName}" and deploy it.`
        : `signed in. No app yet; run '${publishCmd} --name "<app name>"' ` +
          `to create and deploy one (or add a "name" to brass-app.json).`;
    return finish(inp, {
      signed_in: true,
      credential: kind,
      authenticated: true,
      email,
      hosting: null,
      ready_to_publish: true,
      next,
    });
  }

  const hostingProbe = await probeHosting(inp.api, inp.appId);
  if (hostingProbe.missing) {
    return finish(inp, {
      signed_in: true,
      credential: kind,
      authenticated: true,
      email,
      hosting: null,
      ready_to_publish: false,
      next:
        `signed in, but the saved app id ${inp.appId} is not one this credential ` +
        `can publish to. Remove .brass/project.json (or pass --app), then run ` +
        `'${publishCmd}' to create a fresh app.`,
    });
  }
  const h = hostingProbe.hosting;
  const hosting =
    h === null ? null : { enabled: h.enabled, deployed: h.deployed, url: h.url };
  if (h !== null && h.deployed && h.url !== null) {
    return finish(inp, {
      signed_in: true,
      credential: kind,
      authenticated: true,
      email,
      hosting,
      ready_to_publish: true,
      next: `your app is live at ${h.url}. Open it and confirm sign-in works there.`,
    });
  }
  return finish(inp, {
    signed_in: true,
    credential: kind,
    authenticated: true,
    email,
    hosting,
    ready_to_publish: true,
    next: `signed in with app ${inp.appId} ready. Run '${publishCmd}' to deploy.`,
  });
}

// How the credential probe ended. Each outcome has a different fix, so they
// stay distinct: a rejected credential needs a new sign-in, an unreachable
// API needs connectivity, and a fault needs a retry or a bug report.
type AuthProbe =
  | { state: 'ok' }
  | { state: 'rejected' }
  | { state: 'unreachable'; error: string }
  | { state: 'fault'; error: string };

// Auth check shared by every credential kind: `GET /health` is the
// `apps:write`-gated probe a session and a service token can both reach with
// nothing but their own credential (see `whoami`).
//
// Classify by what the probe observed. A 401/403 is a rejected credential,
// from the API or from the session refresh that runs first. Only status 0
// means the request never completed, which is the one state that says
// anything about reachability. Every other status is a fault the server
// answered, so it is not a bad credential either. The distinction is
// load-bearing: labelling a status the server returned "unreachable" points
// the next step at connectivity, and a reader acting on that goes looking
// for blocked egress instead of signing in.
async function probeAuth(api: BrassApi): Promise<AuthProbe> {
  try {
    await api.get<{ ok: true }>('/health');
    return { state: 'ok' };
  } catch (err) {
    if (err instanceof BrassApiError) {
      if (err.status === 401 || err.status === 403) return { state: 'rejected' };
      if (err.status === 0) return { state: 'unreachable', error: err.message };
      return { state: 'fault', error: err.message };
    }
    return { state: 'fault', error: err instanceof Error ? err.message : String(err) };
  }
}

// The signed-in email for the friendly "signed in as ..." line, best-effort.
// `/users/me` carries an identity only for a session; a failure (a service
// token, or any error) just omits the email.
async function probeEmail(api: BrassApi): Promise<string | null> {
  try {
    const me = await api.get<{ email?: string }>('/users/me');
    return typeof me.email === 'string' && me.email.trim() !== '' ? me.email : null;
  } catch {
    return null;
  }
}

// Read an app's hosting so the next step is exact (deploy vs. open the live
// URL). A 404/403 means the saved app id is stale or not this credential's, a
// state worth surfacing; any other error is swallowed so it never blocks.
async function probeHosting(
  api: BrassApi,
  appId: string,
): Promise<{ missing: boolean; hosting: HostingStatus | null }> {
  try {
    const hosting = await api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`);
    return { missing: false, hosting };
  } catch (err) {
    if (err instanceof BrassApiError && (err.status === 404 || err.status === 403)) {
      return { missing: true, hosting: null };
    }
    return { missing: false, hosting: null };
  }
}

// Assemble the result, render the human checklist, and return the structured
// payload (also emitted verbatim under `--json`).
// Report an in-flight sign-in only while it is still approvable: a lapsed
// grant is not a state anyone acts on, and reporting one would send a caller
// to relay a code the approval page refuses.
function pendingLoginReport(inp: StatusInputs): StatusResult['pending_login'] {
  const pending = inp.pendingLogin;
  if (pending === null) return null;
  const remaining = Math.round((pending.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) return null;
  return {
    user_code: pending.userCode,
    verification_url: pending.verificationUrl,
    expires_in_seconds: remaining,
  };
}

function finish(
  inp: StatusInputs,
  rest: Omit<StatusResult, 'profile' | 'app_id' | 'pending_login'>,
): StatusResult {
  const result: StatusResult = {
    profile: inp.profile,
    app_id: inp.appId,
    pending_login: pendingLoginReport(inp),
    ...rest,
  };
  const cred =
    result.credential === 'none'
      ? 'none'
      : result.authenticated === false
        ? `${credentialLabel(result.credential)} (rejected)`
        : result.authenticated === null
          ? `${credentialLabel(result.credential)} (unverified: ${result.unverified_reason ?? 'not probed'})`
          : result.email !== null
            ? `signed in as ${result.email}`
            : `signed in (${credentialLabel(result.credential)})`;
  inp.log.info(`Brass status (${result.profile})`);
  inp.log.info(`  credential:  ${cred}`);
  if (result.pending_login !== null) {
    const p = result.pending_login;
    inp.log.info(
      `  sign-in:     awaiting approval, code ${p.user_code} at ${p.verification_url} ` +
        `(${Math.ceil(p.expires_in_seconds / 60)} min left)`,
    );
  }
  inp.log.info(`  app:         ${result.app_id ?? 'none (a first publish creates one)'}`);
  if (result.hosting !== null) {
    const h = result.hosting;
    const hostingLine = h.url
      ? `${h.url}${h.deployed ? ' (deployed)' : ''}`
      : h.enabled
        ? 'enabled, not deployed'
        : 'not enabled';
    inp.log.info(`  hosting:     ${hostingLine}`);
  }
  inp.log.info('');
  inp.log.success(`Next: ${result.next}`);
  return result;
}

function credentialLabel(kind: CredentialKind): string {
  return kind === 'service' ? 'service token' : kind === 'session' ? 'session' : 'none';
}
