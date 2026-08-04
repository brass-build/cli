// Target + credential resolution for the CLI. Pure functions over an
// explicit inputs bag (flags, env vars, an optional on-disk credentials
// file) so the resolution order is unit-testable without touching the real
// filesystem or `process`.

export interface Origins {
  apiBaseUrl: string;
  authBaseUrl: string;
  dashboardBaseUrl: string;
}

// Production is the default, and the only origin set the package carries: a
// developer publishing needs no configuration to target the real platform,
// and every other stack is named by its URLs, so no deployment's hostname
// scheme is derivable from what ships. Matches the SDK's own defaults.
const PROD_ORIGINS: Origins = {
  apiBaseUrl: 'https://api.brass.build',
  authBaseUrl: 'https://auth.brass.build',
  dashboardBaseUrl: 'https://app.brass.build',
};

export interface OriginOverrides {
  apiBaseUrl?: string;
  authBaseUrl?: string;
  dashboardBaseUrl?: string;
}

// Resolve the three origins, each override winning over the production
// default for its own field. A trailing slash is trimmed, so an origin
// written either way reaches the same credential slot.
export function resolveOrigins(overrides: OriginOverrides): Origins {
  return {
    apiBaseUrl: trimTrailingSlash(overrides.apiBaseUrl ?? PROD_ORIGINS.apiBaseUrl),
    authBaseUrl: trimTrailingSlash(overrides.authBaseUrl ?? PROD_ORIGINS.authBaseUrl),
    dashboardBaseUrl: trimTrailingSlash(
      overrides.dashboardBaseUrl ?? PROD_ORIGINS.dashboardBaseUrl,
    ),
  };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

// The credential-file / project-state key: `prod`, or `origin:<host>` for a
// stack named by URL, so one machine holds a session per target at once
// without collision.
export type Profile = string;

// The on-disk credentials file shape, keyed by profile. `brass login` writes
// a `session` (the opaque platform-session pointer); a `token` slot lets a
// service token be stored too, though CI usually supplies that via
// `BRASS_SERVICE_TOKEN`.
export interface StoredCredential {
  token?: string;
  session?: { sid: string };
}
export interface CredentialsFile {
  version: 1;
  credentials: Record<Profile, StoredCredential>;
}

export interface CredentialInputs {
  // `--token` on the command line.
  flagToken?: string;
  // `BRASS_SERVICE_TOKEN` in the environment (the CI path: a pipeline
  // secret, no interactive login).
  envToken?: string;
  // The credential file parsed off disk, when present.
  file?: CredentialsFile;
  profile: Profile;
}

// A service token is a static bearer; a session is a stored login the CLI
// refreshes into short-lived access tokens.
export type ResolvedCredential =
  | { kind: 'service'; token: string; source: 'flag' | 'env' | 'file' }
  | { kind: 'session'; sid: string; source: 'file' };

// Resolve which credential to use, most-explicit first: an inline `--token`,
// then `BRASS_SERVICE_TOKEN`, then the stored login session, then a stored
// service token. Null when none is available (the caller turns that into the
// "run brass login or set BRASS_SERVICE_TOKEN" guidance).
export function resolveCredential(inputs: CredentialInputs): ResolvedCredential | null {
  if (isNonEmpty(inputs.flagToken)) {
    return { kind: 'service', token: inputs.flagToken.trim(), source: 'flag' };
  }
  if (isNonEmpty(inputs.envToken)) {
    return { kind: 'service', token: inputs.envToken.trim(), source: 'env' };
  }
  const stored = inputs.file?.credentials[inputs.profile];
  if (stored?.session && isNonEmpty(stored.session.sid)) {
    return { kind: 'session', sid: stored.session.sid.trim(), source: 'file' };
  }
  if (isNonEmpty(stored?.token)) {
    return { kind: 'service', token: stored.token.trim(), source: 'file' };
  }
  return null;
}

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

// The profile (credential-file + project-state key) a resolved origin set
// belongs to. Derived from WHERE the invocation points, so a stack named by
// `--api-url` / `--auth-url` is confined to its own slot: keyed on the flags
// instead, every per-URL invocation would land on `prod`, where `brass login`
// overwrites the production session.
export function profileForOrigins(origins: Origins): Profile {
  if (sameOrigins(origins, PROD_ORIGINS)) return 'prod';
  // The data API names the deployment an app id and a session belong to.
  return `origin:${hostOf(origins.apiBaseUrl)}`;
}

function sameOrigins(a: Origins, b: Origins): boolean {
  return (
    a.apiBaseUrl === b.apiBaseUrl &&
    a.authBaseUrl === b.authBaseUrl &&
    a.dashboardBaseUrl === b.dashboardBaseUrl
  );
}

// The host (with port) of a base URL, so the key reads as the stack it names.
// An unparseable value keys on itself, which still gives it its own slot.
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
