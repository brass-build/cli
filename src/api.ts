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
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BrassApiError';
    this.status = status;
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

/** A failed fetch as the caller should read it, naming a timeout as one. */
export function networkError(what: string, cause: unknown): BrassApiError {
  const timedOut =
    cause instanceof Error &&
    (cause.name === 'TimeoutError' || cause.name === 'AbortError');
  return new BrassApiError(
    0,
    timedOut
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
      // Version telemetry; the platform logs it so pinned CI copies
      // stay visible in the deployed-version distribution.
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
      throw new BrassApiError(response.status, await errorMessage(response));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

// Upload bytes to the presigned storage URL the platform handed back.
// Deliberately carries NO Brass headers and no bearer: the presigned
// signature pins an exact header set, so a stray `authorization` header
// invalidates it and the upload is refused.
export async function putPresigned(
  url: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      // fflate allocates a plain ArrayBuffer, so narrowing the generic off
      // `ArrayBufferLike` is sound and satisfies fetch's `BufferSource`
      // (which pins `ArrayBufferView<ArrayBuffer>`) across lib configs.
      body: bytes as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    throw networkError('uploading the bundle', cause);
  }
  if (!response.ok) {
    throw new BrassApiError(response.status, `Bundle upload failed (${response.status})`);
  }
}

// Pull the server's `{ error }` message off a failed response, falling back
// to the bare status when the body is not the expected shape.
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Non-JSON body (an edge / gateway error); fall through to the status.
  }
  return `Request failed with status ${response.status}`;
}
