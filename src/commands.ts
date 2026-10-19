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
  type DocumentDetail,
  type DocumentJoin,
  type DocumentJoinTailOp,
  type DocumentWorkStatus,
  type DocumentStreams,
  type DocumentTypeSummary,
  getPresigned,
  type AgentInstructionsResponse,
  type OrganizationSummary,
  putPresigned,
} from './api.js';
import type { Logger } from './log.js';
import type { Profile, ResolvedCredential } from './config.js';
import {
  loadFirstManifest,
  manifestErrors,
  mergeSchemaIntoManifest,
  publishManifestCandidates,
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
import { basename, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { sdkMismatchMessage, type LoadedSdk } from './sdk-pairing.js';
import {
  SampleTally,
  documentSetListPath,
  pickDocuments,
  type DocumentSetListing,
  type DocumentSetQuery,
  type StreamTally,
} from './sample.js';

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
  // An explicit `--manifest` path, read for a create `name` / `client_token`.
  // Absent searches the bundle's `/.well-known/` copy and then the repo root,
  // so an app that placed its manifest where the capability docs say is found
  // without naming it.
  manifestPath?: string;
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
  // The bundle is read and hashed BEFORE anything about the app is changed.
  // Every step below writes: it creates the app on a first run, moves the
  // visibility, claims the slug, and sets the load gate. A build that emitted
  // nothing, or a directory that is not there, would otherwise leave the app
  // public and ungated and then refuse the publish, so the flags took effect
  // and the bundle they were for never shipped.
  if (!(await isDirectory(opts.dir))) {
    throw new Error(`Publish directory not found: ${opts.dir}`);
  }
  const entries = await collectZipEntries(opts.dir);
  if (Object.keys(entries).length === 0) {
    throw new Error(`No files found to publish under ${opts.dir}`);
  }
  const hash = contentHash(entries);
  await assertManifestValid(ctx, opts);

  const resolved = await resolveOrCreateApp(ctx, opts);
  const appId = resolved.appId;
  if (opts.visibility !== undefined) {
    await ensureVisibility(ctx, appId, opts.visibility, resolved.detail?.visibility);
  }
  const hosting = await ensureHosting(ctx, appId, opts.slug, opts.requireAccess);
  if (opts.requireAccess !== undefined) {
    await ensureGate(ctx, appId, opts.requireAccess, hosting);
  }

  // Skip the upload + unpack-wait when the app already serves this exact
  // bundle. The posture reconcile above still ran, so an unchanged re-publish
  // converges visibility / gate / slug and returns the live URL for the price
  // of a couple of reads instead of an upload and a poll loop.
  const unchanged = await activeVersionMatches(ctx, appId, hash);
  if (unchanged !== null) {
    const status = await awaitSlotReady(
      ctx,
      appId,
      await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`),
      opts.sleep ?? realSleep,
    );
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
  const mintedAt = Date.now();
  const upload = await ctx.api.post<HostingUploadUrl>(
    `/apps/${encodeURIComponent(appId)}/hosting/upload-url`,
    { content_hash: hash, byte_size: bundle.byteLength },
  );
  await putPresigned(upload.upload_url, bundle, 'application/zip', {
    expiresAt: mintedAt + upload.expires_in * 1000,
    sleep: opts.sleep ?? realSleep,
  });

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

  // The status read comes first because the refresh below reads the manifest
  // the app SERVES, and the app names the version it serves a moment after the
  // deploy reports ready. A refresh fired on the ready alone reads the previous
  // version's manifest, or, on a first publish, none at all and a failed read
  // over a deploy that worked.
  const status = await awaitSlotReady(
    ctx,
    appId,
    await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`),
    opts.sleep ?? realSleep,
    version.version_id,
  );

  // Best-effort: the platform crawls the served manifest after a deploy on
  // its own, but an explicit refresh surfaces capability warnings (e.g. a
  // schema missing `family`) right here instead of silently later.
  const warnings = await refreshCapabilities(ctx, appId);

  if (status.url) ctx.log.success(`Deployed: ${status.url}`);
  return { app_id: appId, version_id: version.version_id, url: status.url, warnings };
}

// Refuses a manifest whose shared-schema references cannot resolve, before
// anything about the app changes.
async function assertManifestValid(ctx: CommandContext, opts: PublishOptions): Promise<void> {
  const searched =
    opts.manifestPath !== undefined ? [opts.manifestPath] : publishManifestCandidates(opts.dir);
  const found = await loadFirstManifest(ctx.cwd, searched);
  if (found === null) return;
  const errors = manifestErrors(found.manifest);
  if (errors.length > 0) {
    throw new Error(`${found.path} is not a valid manifest:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  }
}

async function resolveOrCreateApp(
  ctx: CommandContext,
  opts: PublishOptions,
): Promise<{ appId: string; detail?: AppDetail }> {
  if (opts.appId !== undefined) {
    const unused = [
      ...(opts.name !== undefined ? ['--name'] : []),
      ...(opts.organizationId !== undefined ? ['--org'] : []),
      ...(opts.clientToken !== undefined ? ['--client-token'] : []),
    ];
    if (unused.length > 0) {
      ctx.log.warn(
        `${unused.join(', ')} only ${unused.length === 1 ? 'applies' : 'apply'} when publish creates an app, and ${opts.appId} already exists.`,
      );
    }
    return { appId: opts.appId };
  }
  // An explicit `--manifest` names one file and nothing else, so a typo in it
  // is reported rather than silently answered by a manifest somewhere else.
  const searched =
    opts.manifestPath !== undefined ? [opts.manifestPath] : publishManifestCandidates(opts.dir);
  const found = await loadFirstManifest(ctx.cwd, searched);
  const name = opts.name ?? found?.manifest.name;
  if (name === undefined || name.trim() === '') {
    // An explicit `--manifest` that is not there is most likely a typo, so it
    // is named rather than answered by the generic fix.
    const missing =
      opts.manifestPath !== undefined && found === null
        ? ` No manifest at ${opts.manifestPath} (looked at ${searched.join(' and ')}).`
        : '';
    throw new Error(
      'No app to publish to. Pass --name to create one, or --app / BRASS_APP_ID / a .brass/project.json for an existing app.' +
        missing,
    );
  }
  // A `client_token` makes create idempotent, so a repeated create-from-
  // scratch (ephemeral CI has no persisted project.json) resolves the same
  // app rather than minting a duplicate.
  const clientToken = opts.clientToken ?? found?.manifest.client_token;
  const organizationId = await resolveCreateOrganizationId(ctx, opts.organizationId);
  const body: { name: string; organization_id?: string; client_token?: string } = {
    name: name.trim(),
  };
  if (organizationId !== undefined) body.organization_id = organizationId;
  if (typeof clientToken === 'string' && clientToken.trim() !== '') {
    body.client_token = clientToken.trim();
  }
  // A create is the one call that can duplicate an app, and it duplicates
  // silently: the run succeeds, and the second app only shows up later as a
  // pile of them.
  if (body.client_token === undefined) {
    ctx.log.warn(
      'Creating this app without --client-token, so a run that starts with no' +
        ' .brass/project.json creates a second app instead of resolving this' +
        ' one. Pass --client-token <key>, or commit .brass/project.json.',
    );
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
// `false` = world-loadable). Always PATCH, even when the reported state
// already reads `want`: the PATCH is what asks the platform to re-settle a
// gate whose reported and served states have drifted apart, which reading the
// reported one alone cannot detect. Skipping it on a match would leave such an
// app stuck, since every later publish would skip it too. `status` is the
// state `ensureHosting` just observed, used only to word the log line.
// (`require_access` absent === off.)
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

// Enable hosting when the app is not hosted yet, at the load-gate state the
// publish wants. Stating the gate here rather than leaving it to the PATCH
// below settles it in one step: a new slot is gated by default, so a publish
// that wants a world-loadable one would otherwise turn the gate on and
// straight back off, doing twice the work to reach one state.
async function ensureHosting(
  ctx: CommandContext,
  appId: string,
  slug?: string,
  requireAccess?: boolean,
): Promise<HostingStatus> {
  const status = await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`);
  if (status.enabled) {
    if (slug !== undefined && slug !== status.slug) {
      ctx.log.warn(
        `--slug only applies when hosting is first enabled, and this app is already hosted at ${status.slug ?? 'its current address'}.`,
      );
    }
    return status;
  }
  const body: { slug?: string; require_access?: boolean } = {};
  if (slug !== undefined) body.slug = slug;
  if (requireAccess !== undefined) body.require_access = requireAccess;
  const enabled = await ctx.api.post<HostingStatus>(
    `/apps/${encodeURIComponent(appId)}/hosting`,
    body,
  );
  if (enabled.slug) ctx.log.info(`Enabled hosting at ${enabled.slug}`);
  return enabled;
}

// A published bundle is not reachable until the platform has registered the
// slot to serve it, and that registration can lag or fail on its own. Reading
// the status is what asks the platform to settle it, so a slot that is not
// ready yet is re-read a few times before publish gives up. Publishing
// reports success only once the slot will actually serve, so an unreachable
// one is a failed publish rather than a URL that answers 404.
const SLOT_READY_ATTEMPTS = 3;
const SLOT_READY_GAP_MS = 2000;

// Poll the hosting status until it reports what the rest of the publish reads:
// the slot registered, and, when the caller names a version, the app serving
// that one. Reading the manifest the app serves needs the second.
//
// A slot that never registers is fatal, since it will not serve. A version the
// status has not named yet is not: the app names it a moment later, so the
// publish reports what it did rather than failing over the lag.
async function awaitSlotReady(
  ctx: CommandContext,
  appId: string,
  status: HostingStatus,
  sleep: (ms: number) => Promise<void>,
  versionId?: string,
): Promise<HostingStatus> {
  // An api that omits `gate_settled` tells us nothing to act on.
  const ready = (s: HostingStatus): boolean =>
    s.gate_settled !== false && (versionId === undefined || s.active_version === versionId);
  let latest = status;
  for (let attempt = 1; attempt < SLOT_READY_ATTEMPTS && !ready(latest); attempt++) {
    await sleep(SLOT_READY_GAP_MS);
    latest = await ctx.api.get<HostingStatus>(`/apps/${encodeURIComponent(appId)}/hosting`);
  }
  // Says what is true of the SLOT, because both publish paths end here: the
  // one that uploaded a new bundle and the one that found the app already
  // serving this exact bundle and skipped the upload. A message naming an
  // upload sends the second caller looking for one that never happened.
  if (latest.gate_settled === false) {
    throw new Error(
      'The hosted slot never registered, so it will not serve. ' +
        'Run publish again to retry.',
    );
  }
  return latest;
}

// The currently-served version when it is `ready` and already carries `hash`,
// else null. A null (no active version, a non-ready active version, or a hash
// mismatch) means `publish` must upload. A first deploy has no active version,
// so it always uploads.
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
// anything other than a known terminal (`pending`, or any status this pinned
// CLI does not recognize) rather than returning on `!== 'pending'`. That way
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

export interface ContentsOptions {
  docId: string;
  // Which stream to read; the API defaults to `default`.
  stream?: string | undefined;
  branch?: string | undefined;
  // Where to write the JSON. `null` prints it to stdout instead.
  outPath: string | null;
  // How long to wait for a document whose content is still being prepared,
  // in milliseconds. `0` reads once and fails if it is not ready.
  waitMs?: number;
  // Polling knobs (defaulted); overridable so tests don't wait on wall clock.
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ContentsResult {
  doc_id: string;
  stream: string;
  out_path: string | null;
  roots: string[];
  bytes: number;
}

// Read the whole document and write it out as JSON. The output carries every
// record type the document has, which a reader building against an example
// file needs.
export async function documentContents(
  ctx: CommandContext,
  opts: ContentsOptions,
): Promise<ContentsResult> {
  const { join, contents } = await readStreamContents(ctx, opts);
  const roots = Object.keys(contents);
  if (roots.length === 0) {
    ctx.log.warn(`Document ${opts.docId} has no records in its ${opts.stream ?? DEFAULT_STREAM} stream.`);
  }
  const body = serializeContents(contents, opts.docId);
  const bytes = Buffer.byteLength(body, 'utf8');

  if (opts.outPath === null) {
    ctx.log.write(body);
  } else {
    await writeTextFile(opts.outPath, body);
    ctx.log.success(
      `Wrote ${roots.length === 1 ? '1 root' : `${roots.length} roots`} of ${opts.docId} to ${opts.outPath} (${bytes} bytes)`,
    );
  }
  return {
    doc_id: join.doc_id,
    stream: opts.stream ?? DEFAULT_STREAM,
    out_path: opts.outPath,
    roots,
    bytes,
  };
}

type StreamReadOptions = Omit<ContentsOptions, 'outPath'>;

// One stream of one document, read whole: the read `brass contents --doc`
// writes out, and the one a sample repeats per document and stream.
async function readStreamContents(
  ctx: CommandContext,
  opts: StreamReadOptions,
): Promise<{ join: DocumentJoin; contents: Record<string, unknown> }> {
  // Work that REPLACES the document's content holds it read-only while it
  // runs, and the join answers such a document with an empty snapshot: a
  // drive-linked file whose first open enqueues the import is the case that
  // reaches here, and this join is what enqueues it. Writing that out lands
  // an empty file and reports success, which is indistinguishable from a
  // document that really is empty. An outbound push leaves the content
  // readable and is not this.
  let join = await joinDocument(ctx, opts);
  const waitMs = opts.waitMs ?? DEFAULT_CONTENTS_WAIT_MS;
  // Only work that is still running is worth waiting on. Work that has
  // already stopped is answered below without spending a poll on it.
  if (isContentBlocked(join.status) && join.status.pending && waitMs > 0) {
    await awaitContentReady(ctx, opts, join.status, waitMs);
    // One more join, because the poll reads the light route: the content the
    // wait was for arrives only on a route that carries it.
    join = await joinDocument(ctx, opts);
  }
  // A status that has stopped while still blocking is work that ended without
  // content, which is terminal however long anyone waits. `ready` is the one
  // non-terminal reading of that pair, and it is a transient flip on the way
  // to the status clearing, so what tells the two apart is whether the join
  // came back carrying anything.
  if (isContentBlocked(join.status) && !carriesContent(join)) {
    throw contentUnavailable(opts.docId, join.status, waitMs);
  }

  // Loaded here rather than imported at the top: it pulls the CRDT engine's
  // WASM, which no other command needs and every other command would
  // otherwise pay for at startup.
  assertSdkPairing();
  const { decodeJoinContent, readJoinContents } = await import('@brass-build/client/internal');
  // Anything the response could not carry inline arrives as a presigned URL,
  // which is how one response delivers a document of any size. The snapshot
  // is read the way an app reads one, in whichever encoding the join names.
  const [content, ops] = await Promise.all([
    decodeJoinContent(join.snapshot, getPresigned),
    // Seq order, because a tail is replayed in it.
    mapWithConcurrency(
      [...join.tail_ops].sort((a, b) => a.seq - b.seq),
      TAIL_FETCH_CONCURRENCY,
      resolveTailOp,
    ),
  ]);
  return { join, contents: readJoinContents(content, ops) };
}

export interface SampleOptions {
  query: DocumentSetQuery;
  // Read only this stream of each document, rather than every stream it holds.
  stream?: string | undefined;
  // How many of the listed documents to read.
  maxDocuments: number;
  // How many records to keep per record type.
  samplesPerType: number;
  // Where to write the JSON. `null` prints it to stdout instead.
  outPath: string | null;
  waitMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SampledDocument {
  doc_id: string;
  name: string;
  organization_id: string;
  project_id: string | null;
  // The project's name, or null when the document is in no project or the
  // project is not one this credential can list.
  project_name: string | null;
  family?: string;
  file_type?: string;
  // The folder or archive the document sits in, and its path inside it.
  member_of?: { doc_id: string; path: string };
  updated_at: string;
  status?: DocumentWorkStatus;
  // The streams read from this document, once it has been read.
  streams?: string[];
  // Why this document was not read, when it was picked and could not be.
  error?: string;
  // Set when the document was picked and its file has not been imported yet,
  // because only an app can import it. Such a row is not a failure.
  not_imported?: true;
  // Streams of a read document that could not be read, and why.
  stream_errors?: Record<string, string>;
}

/** What `sample.json` contains. */
export interface Sample {
  query: DocumentSetQuery;
  // Documents the listing answered with, and how many of them were read.
  // Folders and archives are not documents here: their files are listed.
  matched: number;
  read: number;
  documents: SampledDocument[];
  streams: Record<string, StreamTally>;
}

/** The command's result: the sample's counts and where it was written. */
export interface SampleResult {
  query: DocumentSetQuery;
  matched: number;
  read: number;
  out_path: string | null;
  bytes: number;
}

// How many documents a sample reads at once. Each read can hold a whole
// large document in memory, so this stays small.
const SAMPLE_READ_CONCURRENCY = 4;

// List the documents a set of references reaches, each read whole without the
// types an app chose it under, then read a spread of them whole and tally their streams by
// record type. Each read is the `--doc` read, so a sampled stream is exactly
// what `brass contents --doc <id> --stream <name>` would have written.
export async function documentSample(
  ctx: CommandContext,
  opts: SampleOptions,
): Promise<SampleResult> {
  const { documents: rows } = await ctx.api.get<{ documents: DocumentSetRow[] }>(
    documentSetListPath(opts.query),
  );
  // A folder or an archive is a place in the listing, and its files are
  // listed as documents of their own.
  const listing = rows.filter((doc) => doc.container === undefined);
  const projectNames = await listProjectNames(ctx, listing);
  const describe = (doc: DocumentSetRow): SampledDocument => ({
    doc_id: doc.doc_id,
    name: doc.name,
    organization_id: doc.organization_id,
    project_id: doc.project_id,
    project_name: doc.project_id === null ? null : (projectNames.get(doc.project_id) ?? null),
    ...(doc.schema_type !== undefined ? { family: doc.schema_type } : {}),
    ...(doc.file_type !== undefined ? { file_type: doc.file_type } : {}),
    ...(doc.member_of !== undefined ? { member_of: doc.member_of } : {}),
    updated_at: doc.updated_at,
    ...(doc.status !== undefined ? { status: doc.status } : {}),
  });
  const documents = listing.map(describe);
  const byId = new Map(documents.map((d) => [d.doc_id, d]));

  let read = 0;
  const picked = pickDocuments(listing, opts.maxDocuments);
  // A listing reads no document, so it needs nothing from the SDK.
  let streams: Record<string, StreamTally> = {};
  if (picked.length > 0) {
    assertSdkPairing();
    const { decodeRecordValue } = await import('@brass-build/client/internal');
    const tally = new SampleTally((value) => decodeRecordValue(value)?.tag ?? null, opts.samplesPerType);
    await mapWithConcurrency(picked, SAMPLE_READ_CONCURRENCY, async (doc) => {
      const entry = byId.get(doc.doc_id)!;
      const readStream = (name: string) =>
        readStreamContents(ctx, {
          docId: doc.doc_id,
          stream: name,
          ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
          ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
          ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
        });
      try {
        let held = await getSchema(ctx, doc.doc_id);
        // Streams read before the import has run are the importer's
        // prediction, and the import can write fewer. The join is what runs
        // the import, so read the default stream first and ask again.
        let readFirst: Record<string, unknown> | undefined;
        if (held.predicted === true) {
          readFirst = (await readStream(DEFAULT_STREAM)).contents;
          held = await getSchema(ctx, doc.doc_id);
        }
        const names =
          opts.stream !== undefined
            ? held.streams.some((s) => s.name === opts.stream)
              ? [opts.stream]
              : []
            : held.streams.map((s) => s.name);
        const done: string[] = [];
        for (const name of names) {
          try {
            const contents =
              name === DEFAULT_STREAM && readFirst !== undefined
                ? readFirst
                : (await readStream(name)).contents;
            tally.add(doc.doc_id, name, held.streams.find((s) => s.name === name)?.schema, contents);
            done.push(name);
          } catch (err) {
            if (refusedAsNotImported(err)) throw err;
            // A stream that cannot be read is reported beside the ones that
            // could, rather than losing the document from the sample.
            const message = err instanceof Error ? err.message : String(err);
            (entry.stream_errors ??= {})[name] = message;
            ctx.log.warn(`${doc.doc_id} stream ${name}: ${message}`);
          }
        }
        entry.streams = done;
        // A document counts as read once one of its streams was. When every
        // stream it was asked for failed, nothing of it reached the sample.
        if (done.length > 0) {
          read += 1;
        } else if (names.length > 0) {
          entry.error =
            names.length === 1
              ? entry.stream_errors![names[0]!]!
              : `None of its streams could be read (${names.join(', ')})`;
        }
      } catch (err) {
        if (refusedAsNotImported(err)) {
          entry.not_imported = true;
          return;
        }
        // One unreadable document is a fact about that document, reported in
        // its row, rather than a reason to lose the rest of the sample.
        entry.error = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`${doc.doc_id}: ${entry.error}`);
      }
    });
    streams = tally.toJSON();
  }

  const payload: Sample = {
    query: opts.query,
    matched: listing.length,
    read,
    documents,
    streams,
  };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (opts.outPath === null) {
    ctx.log.write(body);
  } else {
    await writeTextFile(opts.outPath, body);
    const noun = listing.length === 1 ? 'document' : 'documents';
    const failed = documents.filter((d) => d.error !== undefined).length;
    const waiting = documents.filter((d) => d.not_imported === true).length;
    ctx.log.success(
      (opts.maxDocuments === 0
        ? `Listed ${listing.length} ${noun} to ${opts.outPath}`
        : `Sampled ${read} of ${listing.length} ${noun} to ${opts.outPath}`) +
        ` (${bytes} bytes)` +
        (failed > 0 ? `; ${failed} could not be read` : '') +
        (waiting > 0 ? `; ${waiting} not imported yet` : ''),
    );
  }
  return { query: opts.query, matched: listing.length, read, out_path: opts.outPath, bytes };
}

// The names of the projects a listing's documents are filed in, from one
// read of the caller's projects. The names only label the rows, so a failed
// read leaves them null rather than failing the sample.
async function listProjectNames(
  ctx: CommandContext,
  listing: readonly DocumentSetRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!listing.some((doc) => doc.project_id !== null)) return names;
  try {
    const { projects } = await ctx.api.get<{
      projects: { project_id: string; name: string }[];
    }>('/projects');
    for (const project of projects) names.set(project.project_id, project.name);
  } catch (err) {
    ctx.log.warn(
      `Could not read project names: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return names;
}

// The join refuses a file only an app can import with this code.
function refusedAsNotImported(err: unknown): boolean {
  return err instanceof BrassApiError && err.code === 'not_imported';
}

type DocumentSetRow = DocumentSetListing & { container?: unknown };

// The stream a join reads when the caller names none. The API owns the
// default; this is only what the result reports back.
const DEFAULT_STREAM = 'default';

// How long a read waits on a document whose content is still being prepared.
//
// The command's own join is what enqueues that work for a drive-linked file's
// first open, so refusing and telling the caller to try later hands them a
// wait they then have to run by hand. `brass publish` already waits on the
// slow work it starts; this is the same bargain.
//
// Work still unfinished after 900s has stopped rather than slowed, so waiting
// longer reports nothing this budget would not.
const DEFAULT_CONTENTS_WAIT_MS = 900_000;
// The poll starts at 2s and stretches to 15s, so a quick import is noticed
// quickly and a long one costs a few dozen status reads rather than hundreds.
const CONTENTS_POLL_INTERVAL_MS = 2_000;
const CONTENTS_POLL_MAX_INTERVAL_MS = 15_000;
const CONTENTS_POLL_GROWTH = 1.5;
const POLL_FAILURES_TOLERATED = 5;

// Narrows as well as answers: a blocked status is by definition present, and
// every caller here goes on to read its wording.
function isContentBlocked(
  status: DocumentWorkStatus | undefined,
): status is DocumentWorkStatus {
  return status?.blocking === true;
}

// Whether a join carries document state at all. A never-compacted document
// lives entirely in its tail, so neither half alone answers this.
function carriesContent(join: DocumentJoin): boolean {
  return join.snapshot !== null || join.tail_ops.length > 0;
}

async function joinDocument(ctx: CommandContext, opts: StreamReadOptions): Promise<DocumentJoin> {
  const { SEALED_ACCEPT } = await import('@brass-build/client/internal');
  return ctx.api.get<DocumentJoin>(contentsJoinPath(opts, SEALED_ACCEPT));
}

/** The join `brass contents` makes. It opens the document to read, so
 *  running the command leaves the document as it was. `accept` is the paired
 *  client's `SEALED_ACCEPT`. */
export function contentsJoinPath(
  opts: Pick<ContentsOptions, 'docId' | 'stream' | 'branch'>,
  accept: string,
): string {
  const query = new URLSearchParams({ include: 'snapshot', intent: 'read', accept });
  if (opts.stream !== undefined) query.set('stream', opts.stream);
  if (opts.branch !== undefined) query.set('branch', opts.branch);
  return `/documents/${encodeURIComponent(opts.docId)}?${query.toString()}`;
}

// Poll until the document's inbound work stops, or the budget runs out.
//
// The poll reads the document's metadata rather than re-joining: a join
// delivers the whole document, so polling one would download it on every
// poll. The metadata carries the same status.
//
// Returning is not a claim that the content arrived, only that the work
// stopped; the caller re-joins and reads what it actually got.
async function awaitContentReady(
  ctx: CommandContext,
  opts: StreamReadOptions,
  initial: DocumentWorkStatus,
  waitMs: number,
): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  let intervalMs = opts.pollIntervalMs ?? CONTENTS_POLL_INTERVAL_MS;
  // One line per phase, not one per attempt: the platform re-words the status
  // as the work moves between steps, and that transition is the only thing a
  // reader learns from a second line. A heartbeat every couple of seconds
  // would bury it, and a long import would fill a CI log with it.
  let said = initial.message;
  ctx.log.info(`${opts.docId}: ${said}`);
  let consecutiveFailures = 0;
  let waited = 0;
  do {
    const step = Math.max(0, Math.min(intervalMs, waitMs - waited));
    await sleep(step);
    waited += step;
    intervalMs = Math.min(intervalMs * CONTENTS_POLL_GROWTH, CONTENTS_POLL_MAX_INTERVAL_MS);
    let detail: DocumentDetail;
    try {
      detail = await ctx.api.get<DocumentDetail>(`/documents/${encodeURIComponent(opts.docId)}`);
      consecutiveFailures = 0;
    } catch (err) {
      // A status read is idempotent and the next one is seconds away, so one
      // that fails is worth another attempt: this wait is minutes long, and
      // ending it on a single blip costs the caller the whole import even
      // though the work continues on the server. A run of them is something
      // else (a credential that expired, a document that was deleted), and
      // that error is the answer rather than a silent spin, so only
      // CONSECUTIVE failures count and a success clears them.
      consecutiveFailures += 1;
      if (consecutiveFailures > POLL_FAILURES_TOLERATED) throw err;
      continue;
    }
    const status = detail.status;
    if (!isContentBlocked(status) || !status.pending) return;
    if (status.message !== said) {
      said = status.message;
      ctx.log.info(`${opts.docId}: ${said}`);
    }
  } while (waited < waitMs);
}

// Why a document could not be read, in the caller's terms.
//
// The three cases differ in what the caller should do next, and saying "run
// this again once it settles" to all of them is advice that is wrong for two
// of them: work that has stopped never settles, and a caller who asked not to
// wait wants to know that waiting is available.
function contentUnavailable(
  docId: string,
  status: DocumentWorkStatus | undefined,
  waitMs: number,
): Error {
  const message = status?.message ?? 'The content is not available.';
  if (status?.pending !== true) {
    return new Error(`${docId} could not be prepared: ${message}`);
  }
  if (waitMs === 0) {
    return new Error(
      `${docId} is not readable yet: ${message} It is still being prepared; ` +
        `drop --no-wait to wait for it.`,
    );
  }
  // A longer wait than the default reports nothing the default would not, so
  // the advice is offered only to a caller who chose a shorter one.
  const advice =
    waitMs < DEFAULT_CONTENTS_WAIT_MS
      ? 'run this again, or pass --wait <seconds> to wait longer.'
      : 'run this again later.';
  return new Error(
    `${docId} is not readable yet: ${message} It was still being prepared after ` +
      `${formatDuration(waitMs)}; ${advice}`,
  );
}

// Refuse an SDK that is not the one this CLI names, before reaching for
// anything in it. `sdk-pairing.ts` carries why the version is what gets
// compared; this is the half that reads the two numbers off disk.
function assertSdkPairing(): void {
  const message = sdkMismatchMessage({
    pinned: readOwnPin(),
    loaded: resolveLoadedSdk(),
  });
  if (message !== null) throw new Error(message);
}

// The version this build names, from the CLI's own manifest. `..` from either
// layout the module runs in (`dist/commands.js` installed, `src/commands.ts`
// in the repo) is the package root.
function readOwnPin(): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    return manifest.dependencies?.['@brass-build/client'];
  } catch {
    return undefined;
  }
}

// The copy that would answer an import from here, or null when none is
// installed to read (an in-repo run maps the specifier to source).
function resolveLoadedSdk(): LoadedSdk | null {
  try {
    const path = createRequire(import.meta.url).resolve(
      '@brass-build/client/package.json',
    );
    const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
    return { version, path };
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

// How many of a tail's presigned ops are fetched at once.
//
// A tail can name a large number of ops whose bytes are fetched separately,
// and that is the ordinary case rather than the rare one: a bulk write puts
// nearly every op's bytes outside the response. Firing them all together
// opens a connection per op and draws resets, on a link that is somebody's
// home connection. Bounded so the fetch finishes instead of failing partway.
const TAIL_FETCH_CONCURRENCY = 16;

// `Promise.all` with a ceiling on how many run together, preserving input
// order in the result.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// One JSON string is what a caller reads and pipes, and V8 caps a single
// string at 512 MiB however much memory the machine has. A document past
// that throws a `RangeError` naming neither the document nor the limit, so
// the ceiling is stated here rather than left to surface as a bare
// `Invalid string length` out of `JSON.stringify`.
function serializeContents(contents: object, docId: string): string {
  try {
    return `${JSON.stringify(contents, null, 2)}\n`;
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new Error(
        `${docId} holds more than a single JSON string can carry (512 MiB), ` +
          `so it cannot be written as one file. Read a smaller stream of it ` +
          `with --stream <name>.`,
      );
    }
    throw cause;
  }
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function resolveTailOp(op: DocumentJoinTailOp): Promise<Uint8Array> {
  return 'op_blob_b64' in op
    ? decodeBase64(op.op_blob_b64)
    : await getPresigned(op.op_blob_url);
}

// What `schema pull` and `contents` say about a document nothing has written
// records under a schema for: a file no importer has read, or a document
// with no type.
function noSchemaMessage(docId: string): string {
  return `Document ${docId} has no schema: no importer or app has written records under one.`;
}

// A document's streams and their schemas. The route answers a document it
// finds no schema for with a 404 coded `no_schema`, and a missing document
// with "Document not found", which passes through. A server answering with
// no code is told apart by its message.
async function getSchema(ctx: CommandContext, docId: string): Promise<DocumentStreams> {
  try {
    return await ctx.api.get<DocumentStreams>(`/documents/${encodeURIComponent(docId)}/schema`);
  } catch (err) {
    if (
      err instanceof BrassApiError &&
      err.status === 404 &&
      (err.code === 'no_schema' || (err.code === undefined && /schema/i.test(err.message)))
    ) {
      throw new Error(noSchemaMessage(docId));
    }
    throw err;
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
  const summary = await ctx.api.get<DocumentTypeSummary>(
    `/documents/${encodeURIComponent(opts.docId)}`,
  );
  // An app manifest is a CLAIM the developer is about to author: a family
  // plus a body per stream. The document holds no such thing, only streams,
  // so the manifest is ASSEMBLED here rather than read off the document.
  // Each published body goes in verbatim; the family is the document's own
  // type, the same token open-routing matches on. A stream the document
  // holds with no published contract is left out: a manifest entry is a
  // shape the app declares it works with, and there is no shape to declare.
  const family = summary.schema_type ?? '';
  if (family === '') throw new Error(noSchemaMessage(opts.docId));
  const held = await getSchema(ctx, opts.docId);
  const streams: Record<string, Record<string, unknown>> = {};
  for (const entry of held.streams) {
    if (entry.schema !== undefined) streams[entry.name] = entry.schema;
  }
  // A family names no shape on its own, so a manifest with no stream bodies
  // declares nothing a reader could rely on, and publish refuses it.
  if (Object.keys(streams).length === 0) {
    throw new Error(
      `Document ${opts.docId} has no published schema for any of its streams, so there is nothing to declare. ` +
        'The app or importer that wrote it publishes none, or you cannot read the one it publishes.',
    );
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
  // Who is signed in, for a `brass login` session. Both are null for a
  // service token, which is an organization's credential rather than a
  // person's.
  email: string | null;
  organizations: OrganizationSummary[] | null;
}

// Confirm the resolved credential authenticates, over the `apps:write`-gated
// probe (`GET /health`) both credential kinds can reach: a service token is an
// org-scoped identity that enumerates no membership, so it has no org id to
// address an org-scoped read with. A 401 (rejected credential) or 403 (a token
// without the publish capability) surfaces as a thrown BrassApiError the CLI
// turns into a non-zero exit. A session then reports the person it belongs to.
export async function whoami(ctx: CommandContext): Promise<WhoamiResult> {
  await ctx.api.get<{ ok: true }>('/health');
  if (ctx.credentialKind !== 'session') {
    ctx.log.success('Authenticated with a service token. This credential can publish.');
    return { authenticated: true, email: null, organizations: null };
  }
  const [me, organizations] = await Promise.all([
    ctx.api.get<{ email?: string }>('/users/me'),
    listCallerOrganizations(ctx),
  ]);
  const email = typeof me.email === 'string' && me.email.trim() !== '' ? me.email : null;
  ctx.log.success(
    `Signed in${email !== null ? ` as ${email}` : ''}. This credential can publish.`,
  );
  if (organizations.length === 0) {
    ctx.log.info('You do not belong to any organization.');
  } else {
    ctx.log.info('Organizations:');
    for (const org of organizations) ctx.log.info(`  ${org.name} (${org.organization_id})`);
  }
  return {
    authenticated: true,
    email,
    organizations: organizations.map(({ organization_id, name }) => ({ organization_id, name })),
  };
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
  // The origin flags `status` was given, as argv words. Every command the
  // next step names carries them, so it targets the stack `status` read.
  originFlags: string[];
  // A device grant `brass login --start` minted that no one has approved yet.
  // Reporting it (and how long it has left) is what lets a caller tell a
  // sign-in that is still relayable from one it has to restart, which is the
  // difference between waiting and asking the human for a second approval.
  pendingLogin: { userCode: string; verificationUrl: string; expiresAt: number } | null;
  // An app approval `brass browser-session` asked for that no one has granted
  // yet. Reported for the same reason the pending sign-in is: it is a step
  // only the human can take, so a caller that does not hear about it has no
  // way to know why the app it just asked about is refused.
  pendingApproval: { appId: string; approvalUrl: string; expiresAt: number } | null;
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
  // The app approval awaiting a human, when one is outstanding for the app
  // this status resolved, with the seconds it has left.
  pending_approval: {
    app_id: string;
    approval_url: string;
    expires_in_seconds: number;
  } | null;
  app_id: string | null;
  hosting: { enabled: boolean; deployed: boolean; url: string | null } | null;
  // Whether the state is such that a `publish` would proceed (a credential
  // that authenticates, and either a resolvable app or a create name; a
  // signed-in person's create also needs one organization to own the app).
  ready_to_publish: boolean;
  // The single imperative next action, as a command where one applies. This is
  // the field an agent acts on: it names the next step rather than describing
  // how publishing works.
  next: string;
}

// One command a next step names, runnable as printed from where `status` ran.
function nextCommand(inp: StatusInputs, args: string): string {
  return ['brass', args, ...inp.originFlags].join(' ');
}

// The publish directory as a shell word: a bare relative path gains `./` so it
// reads as a path, and one the shell would split or expand is quoted.
function publishDirArg(dir: string): string {
  const path = isAbsolute(dir) || /^\.\.?([\\/]|$)/.test(dir) ? dir : `./${dir}`;
  return /^[\w./\\:@%+=,-]+$/.test(path) ? path : `"${path.replace(/["$`]/g, '\\$&')}"`;
}


// Report the publish readiness of the current directory + credential and,
// crucially, the one command to run next. `whoami` answers "does my token
// work"; `status` answers "what do I do now", so an agent follows its output
// instead of re-deriving the publish flow from prose under friction. It never
// throws on a missing or rejected credential: those are first-class states it
// reports and turns into a next step, not errors.
export async function status(inp: StatusInputs): Promise<StatusResult> {
  const brass = (args: string): string => nextCommand(inp, args);
  const dirArg = publishDirArg(inp.publishDir);
  const publishCmd = brass(`publish ${dirArg}`);
  const statusCmd = brass(inp.publishDir === 'dist' ? 'status' : `status ${dirArg}`);
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
          ? `a sign-in for ${inp.profile} is waiting for approval: put ` +
            `${pending.verificationUrl} and the code ${pending.userCode} in your ` +
            `reply, where the user will read them, then run ` +
            `'${brass('login --check --wait')}'. It polls until they approve and renews ` +
            `the code if it lapses, so there is no need to start a second sign-in.`
          : `no credential for ${inp.profile}. Run '${brass('login --start')}' to begin a ` +
            `sign-in, put the URL and short code it prints in your reply, then run ` +
            `'${brass('login --check --wait')}' until it reports approved (or set ` +
            `BRASS_SERVICE_TOKEN). The session feeds the build steps ` +
            `('${brass('agents pull')}' for the organization's instructions, ` +
            `'${brass('schema pull')}' for your example document's schema) as well as ` +
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
            `then run '${statusCmd}' again.`
          : `the Brass API answered, but the credential could not be verified ` +
            `(${probe.error}). The credential was not rejected and the API is ` +
            `reachable, so run '${statusCmd}' again.`,
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
          ? `the stored sign-in was rejected. Run '${brass('login --start')}' to begin a ` +
            `new one, relay the printed URL + code, then '${brass('login --check --wait')}'.`
          : `the service token was rejected. Check BRASS_SERVICE_TOKEN or --token.`,
    });
  }

  const email = kind === 'session' ? await probeEmail(inp.api) : null;

  // Verified. What would `publish` target? A service token's create binds to
  // the token's own org by default, so no `--org` is needed to stand one up.
  // A signed-in person's create needs exactly one organization to own the app,
  // or `--org` to name one, so the report reads the same list publish reads.
  if (inp.appId === null) {
    const organizations = kind === 'session' ? await probeOrganizations(inp.api) : null;
    if (organizations !== null && organizations.length === 0) {
      return finish(inp, {
        signed_in: true,
        credential: kind,
        authenticated: true,
        email,
        hosting: null,
        ready_to_publish: false,
        next:
          `signed in, but you do not belong to any organization, so a first ` +
          `publish has nothing to own the app. Create or join one in the ` +
          `dashboard, then run '${statusCmd}' again.`,
      });
    }
    const createCmd =
      organizations !== null && organizations.length > 1
        ? `${publishCmd} --org <organizationId>`
        : publishCmd;
    const next =
      inp.manifestName !== null
        ? `signed in. No app yet; run '${createCmd}' to create ` +
          `"${inp.manifestName}" and deploy it.`
        : `signed in. No app yet; run '${createCmd} --name "<app name>"' ` +
          `to create and deploy one.`;
    if (organizations !== null && organizations.length > 1) {
      const names = organizations
        .map((o) => `${o.organization_id} (${o.name})`)
        .join(', ');
      return finish(inp, {
        signed_in: true,
        credential: kind,
        authenticated: true,
        email,
        hosting: null,
        ready_to_publish: false,
        next:
          `${next} You belong to several organizations, so --org names the one ` +
          `that owns the app. Available: ${names}`,
      });
    }
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

// The organizations a first publish would choose an owner from, or null when
// the list could not be read (publish then reports it for itself).
async function probeOrganizations(api: BrassApi): Promise<OrganizationSummary[] | null> {
  try {
    const { organizations } = await api.get<{ organizations: OrganizationSummary[] }>(
      '/organizations',
    );
    return Array.isArray(organizations) ? organizations : null;
  } catch {
    return null;
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

// Report an outstanding approval only while the link is still good and only
// against the app this status resolved, so a caller is never sent to relay a
// URL the page refuses or one that answers a question about another app.
function pendingApprovalReport(inp: StatusInputs): StatusResult['pending_approval'] {
  const pending = inp.pendingApproval;
  if (pending === null || pending.appId !== inp.appId) return null;
  const remaining = Math.round((pending.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) return null;
  return {
    app_id: pending.appId,
    approval_url: pending.approvalUrl,
    expires_in_seconds: remaining,
  };
}

function finish(
  inp: StatusInputs,
  rest: Omit<StatusResult, 'profile' | 'app_id' | 'pending_login' | 'pending_approval'>,
): StatusResult {
  const pendingApproval = pendingApprovalReport(inp);
  const result: StatusResult = {
    profile: inp.profile,
    app_id: inp.appId,
    pending_login: pendingLoginReport(inp),
    pending_approval: pendingApproval,
    ...rest,
    // An outstanding approval outranks whatever this branch would otherwise
    // say, on the same terms as the pending sign-in above it: it is the one
    // step the caller cannot take itself, and everything else the branch could
    // name is a step it can. Only once the credential is good, since an
    // approval is moot to a caller that cannot authenticate at all.
    ...(pendingApproval !== null && rest.authenticated === true
      ? {
          next:
            `${pendingApproval.app_id} is waiting for approval before it can be opened ` +
            `in a browser: give the user ${pendingApproval.approval_url} and ask them to ` +
            `approve, then run '${nextCommand(inp, 'browser-session')}' again. ` +
            `Publishing is unaffected.`,
        }
      : {}),
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
  if (result.pending_approval !== null) {
    const a = result.pending_approval;
    inp.log.info(
      `  approval:    awaiting a human at ${a.approval_url} ` +
        `(${Math.ceil(a.expires_in_seconds / 60)} min left)`,
    );
  }
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
