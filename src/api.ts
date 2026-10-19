// The HTTP client the commands share: a bearer-authenticated wrapper over
// the Brass data API, plus the narrow wire types the CLI reads. Wire shapes
// are declared here (not imported from `@brass-build/client`) so the CLI
// stays a standalone package with no browser-SDK dependency; the shapes it
// depends on are small and stable (the `/apps` + hosting surface).

import type { AuthProvider } from './auth.js';
import { CLI_CLIENT_ID } from './version.js';

// A schema manifest as it rides on the wire (a document's resolved schema
// and an app's `schema` declaration): the artifact's family word plus each
// stream's JSON Schema. The CLI never interprets it, only transports it
// verbatim.
export interface BrassSchemaManifest {
  family: string;
  streams: Record<string, Record<string, unknown>>;
}

export type AppVisibility = 'private' | 'invitee_visible' | 'public';

export interface AppDetail {
  app_id: string;
  name: string;
  owner_organization_id?: string;
  visibility?: AppVisibility;
}

export interface HostingStatus {
  enabled: boolean;
  slug: string | null;
  url: string | null;
  deployed: boolean;
  active_version: string | null;
  // Whether the edge gates the bundle behind the app's audience. A public
  // showcase turns this off so the bundle is world-loadable.
  require_access?: boolean;
  // Whether the platform has registered this slot to serve. False means the
  // hosted URL answers 404 however the rest of this body reads. Optional: an
  // older api omits it, and an absent field is not a failure to report.
  gate_settled?: boolean;
}

export interface HostingUploadUrl {
  upload_url: string;
  version_id: string;
  expires_in: number;
}

export type HostingVersionStatus = 'pending' | 'ready' | 'failed';

export interface HostingVersion {
  version_id: string;
  status: HostingVersionStatus;
  failure_reason?: string;
  active: boolean;
  // The deterministic content hash the publishing client recorded for this
  // version's bundle (absent on versions uploaded before hashing was added).
  // `publish` compares it against the local bundle to skip an unchanged
  // re-upload.
  content_hash?: string;
}

// What a document holds: its streams and the contract of each. A document
// is a set of streams, not a representation, so this carries no family; the
// document's TYPE is the `schema_type` on its detail response, which is what
// `schema pull` assembles the app manifest's `family` from.
export interface DocumentStreams {
  // `schema` is absent on a stream the document holds whose contract does
  // not resolve: nobody published one under that name, or this caller is
  // outside the publisher's read audience.
  streams: { name: string; schema?: Record<string, unknown> }[];
  // Set when the document holds no records yet, so the streams are the ones
  // the importing app says it will produce. Still the right thing to build
  // against; the CLI transports it either way.
  predicted?: true;
}

export interface DocumentTypeSummary {
  schema_type?: string;
}

// The join's snapshot and tail-op shapes (`GET /documents/:docId
// ?include=snapshot`). Anything the response cannot carry inline arrives as a
// short-lived presigned URL, which is what lets one response deliver a
// document of any size; the join refuses outright rather than serving a
// partial one, so a payload that arrives is complete.
export type DocumentJoinSnapshot =
  | { kind: 'inline'; data_b64: string }
  | { kind: 'presigned'; url: string; expires_at: string; raw_bytes: number }
  | { kind: 'sealed'; url: string; expires_at: string; raw_bytes: number };

export type DocumentJoinTailOp =
  | { seq: number; op_blob_b64: string }
  | { seq: number; op_blob_url: string; op_blob_bytes: number };

// Slow asynchronous work on a document (an import that replaces its content,
// a push that writes it out). `message` is written to be read verbatim, and
// the platform owns every word: nothing here branches on a phase or maps a
// code to copy.
//
// `blocking` is the half that matters to a reader. Work that REPLACES the
// content holds the document read-only, so the join answers with an empty
// snapshot until it finishes; a push leaves the content readable. `pending`
// is what separates work still running from work that has stopped, and the
// two together are what a wait watches: `pending` false with `blocking` still
// true is work that ended without producing content, which no amount of
// waiting changes.
export interface DocumentWorkStatus {
  message: string;
  pending: boolean;
  blocking: boolean;
  // 0..1, present only on a step the platform can honestly measure.
  progress?: number;
}

export interface DocumentJoin {
  doc_id: string;
  branch_id: string;
  stream_branch_id?: string;
  name?: string;
  schema_type?: string;
  snapshot: DocumentJoinSnapshot | null;
  tail_ops: DocumentJoinTailOp[];
  snapshot_seq: number;
  current_seq: number;
  // Slow asynchronous work on the document, absent in the steady state.
  status?: DocumentWorkStatus;
}

// The slice of `GET /documents/{docId}` (without `?include=snapshot`) a
// blocked read polls. It carries the document's status without its content.
export interface DocumentDetail {
  doc_id: string;
  status?: DocumentWorkStatus;
}

// An organization's agentic-coding instructions (its AGENTS.md / CLAUDE.md
// body), from `GET /organizations/:id/agent-instructions`. `content` is empty
// when the org has never set them.
export interface AgentInstructionsResponse {
  content: string;
  updated_at?: string;
  updated_by?: string;
}

// The narrow slice of `GET /organizations` the CLI reads: enough to resolve a
// single-org caller's org id and to name the orgs when the caller must pick.
export interface OrganizationSummary {
  organization_id: string;
  name: string;
}

export interface RefreshCapabilitiesResponse {
  app_id: string;
  manifest_origin: string;
  opens: string[];
  warnings?: string[];
}

// One error type for every API failure, carrying the HTTP status and the
// server-authored message so the CLI can render it verbatim (the API returns
// `{ error: string }` on the 4xx/5xx ladder).
export class BrassApiError extends Error {
  readonly status: number;
  // The machine-readable `code` the API sent beside `error`, when it sent one.
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'BrassApiError';
    this.status = status;
    this.code = code;
  }
}

// `fetch` carries no timeout of its own, so a host that accepts the connection
// and then answers nothing holds the command open for as long as the caller
// leaves it running. In CI that is a job that never finishes rather than a
// failure anyone can read, so every request the CLI makes is bounded.
const REQUEST_TIMEOUT_MS = 30_000;
// The upload carries the whole bundle, so it is bounded far more loosely than
// a request that carries a few hundred bytes.
const UPLOAD_TIMEOUT_MS = 300_000;

/**
 * Fetch bytes from a presigned URL. Not an API call: the signature is the
 * credential, so no auth header goes with it, and sending one is refused as
 * a second credential on the request.
 */
export async function getPresigned(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  } catch (cause) {
    throw networkError('fetching document bytes', cause);
  }
  if (!response.ok) {
    throw new BrassApiError(
      response.status,
      `Could not fetch the document's bytes (${response.status}).`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function isTimeout(cause: unknown): boolean {
  return (
    cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  );
}

/** A failed fetch as the caller should read it, naming a timeout as one. */
export function networkError(what: string, cause: unknown): BrassApiError {
  return new BrassApiError(
    0,
    isTimeout(cause)
      ? `Timed out ${what}.`
      : `Network error ${what}: ${String(cause)}`,
  );
}

export class BrassApi {
  private readonly apiBaseUrl: string;
  private readonly auth: AuthProvider;

  constructor(apiBaseUrl: string, auth: AuthProvider) {
    this.apiBaseUrl = apiBaseUrl;
    this.auth = auth;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      ...(await this.auth.headers()),
      // Names this CLI and its version. Brass answers a build too old to
      // serve with an upgrade message, rather than a failure that names
      // something else.
      'x-brass-client': CLI_CLIENT_ID,
    };
    let init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init = { ...init, body: JSON.stringify(body) };
    }
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw networkError(`reaching ${this.apiBaseUrl}`, cause);
    }
    if (!response.ok) {
      const { message, code } = await errorBody(response);
      throw new BrassApiError(response.status, message, code);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

// How many times one upload is attempted, counting the first.
const UPLOAD_MAX_ATTEMPTS = 4;
const UPLOAD_RETRY_BASE_MS = 1_000;
const UPLOAD_RETRY_MAX_MS = 8_000;
// A retry has to start this long before the URL expires, or it is not sent.
const UPLOAD_EXPIRY_MARGIN_MS = 10_000;

export interface PutPresignedOptions {
  /** When the URL stops being accepted, in epoch ms. */
  expiresAt?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

// Storage answers 500 and 503 when it is briefly overloaded and asks for the
// request again. Every other status is the answer.
function retryableUploadStatus(status: number): boolean {
  return status === 500 || status === 503;
}

// Upload bytes to the presigned storage URL the platform handed back.
// Deliberately carries NO Brass headers and no bearer: the presigned
// signature pins an exact header set, so a stray `authorization` header
// invalidates it and the upload is refused.
//
// A 500, a 503 or a failed connection is tried again after a jittered,
// growing wait, as long as the next attempt starts well before the URL
// expires. The body is a buffer, so each attempt sends it whole. An attempt
// that runs out of time is not tried again, since another on the same
// connection would time out the same way.
export async function putPresigned(
  url: string,
  bytes: Uint8Array,
  contentType: string,
  opts: PutPresignedOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    let failure: BrassApiError;
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        // fflate allocates a plain ArrayBuffer, so narrowing the generic off
        // `ArrayBufferLike` is sound and satisfies fetch's `BufferSource`
        // (which pins `ArrayBufferView<ArrayBuffer>`) across lib configs.
        body: bytes as Uint8Array<ArrayBuffer>,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (response.ok) return;
      if (!retryableUploadStatus(response.status)) {
        throw new BrassApiError(response.status, `Bundle upload failed (${response.status})`);
      }
      failure = new BrassApiError(response.status, `storage answered ${response.status}`);
    } catch (cause) {
      if (cause instanceof BrassApiError) throw cause;
      if (isTimeout(cause)) {
        throw new BrassApiError(0, UPLOAD_TIMED_OUT_MESSAGE);
      }
      failure = networkError('uploading the bundle', cause);
    }

    const delay = Math.round(
      random() * Math.min(UPLOAD_RETRY_MAX_MS, UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1)),
    );
    const outOfAttempts = attempt >= UPLOAD_MAX_ATTEMPTS;
    const outOfTime =
      opts.expiresAt !== undefined && now() + delay > opts.expiresAt - UPLOAD_EXPIRY_MARGIN_MS;
    if (outOfAttempts || outOfTime) {
      throw new BrassApiError(failure.status, uploadGaveUpMessage(failure, attempt, outOfAttempts));
    }
    await sleep(delay);
  }
}

function uploadGaveUpMessage(failure: BrassApiError, attempts: number, outOfAttempts: boolean): string {
  const tries = attempts === 1 ? '1 attempt' : `${attempts} attempts`;
  const what =
    failure.status === 0
      ? failure.message.replace(/\.$/, '')
      : `Bundle upload failed: storage answered ${failure.status}`;
  const why = outOfAttempts
    ? `after ${tries}`
    : `after ${tries}, and the upload URL expires before another could start`;
  return `${what} ${why}. Storage was busy or unreachable; run the command again.`;
}

const UPLOAD_TIMED_OUT_MESSAGE =
  'The bundle upload did not finish in time. ' +
  'The connection to storage was too slow or stalled. Check the connection and run the command again.';

// Pull the server's `{ error }` message off a failed response, falling back
// to the bare status when the body is not the expected shape.
async function errorBody(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    const code = typeof body.code === 'string' && body.code !== '' ? body.code : undefined;
    if (typeof body.error === 'string' && body.error !== '') {
      return { message: body.error, ...(code !== undefined ? { code } : {}) };
    }
  } catch {
    // Non-JSON body (an edge / gateway error); fall through to the status.
  }
  return { message: `Request failed with status ${response.status}` };
}
