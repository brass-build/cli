import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CredentialsFile, Profile, StoredCredential } from './config.js';

// Where `brass login` persists its credential, and where
// `publish` / `schema` / `whoami` look for it when no `--token` /
// `BRASS_SERVICE_TOKEN` was given. Honors `XDG_CONFIG_HOME`, else
// `~/.config/brass/credentials.json`.
export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_CONFIG_HOME'];
  const root = base && base.trim() !== '' ? base : join(homedir(), '.config');
  return join(root, 'brass', 'credentials.json');
}

export async function readCredentialsFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialsFile | null> {
  try {
    const raw = await readFile(credentialsFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (parsed.version !== 1 || typeof parsed.credentials !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Merge one profile's stored credential into the file (0600 so the session
// pointer is not world-readable), or clear it when `credential` is null.
// Preserves the other env's entry.
export async function writeStoredCredential(
  target: Profile,
  credential: StoredCredential | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const existing = (await readCredentialsFile(env)) ?? { version: 1 as const, credentials: {} };
  const credentials = { ...existing.credentials };
  if (credential === null) delete credentials[target];
  else credentials[target] = credential;
  await writeOwnerOnlyJson(credentialsFilePath(env), { version: 1, credentials } satisfies CredentialsFile);
}

// A device-authorization grant `brass login --start` has minted but the
// human has not yet approved. `brass login --check` reloads it to make its
// one poll; approval, denial, or expiry clears it.
export interface PendingLogin {
  authBaseUrl: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresAt: number;
}

interface PendingLoginsFile {
  version: 1;
  pending: Record<Profile, PendingLogin>;
}

// Sibling of the credentials file: the in-flight sign-in per profile. Kept
// out of credentials.json so starting a new sign-in never disturbs a stored
// session until the new grant is approved.
export function pendingLoginFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsFilePath(env)), 'pending-login.json');
}

async function readPendingLoginsFile(env: NodeJS.ProcessEnv): Promise<PendingLoginsFile | null> {
  try {
    const raw = await readFile(pendingLoginFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as PendingLoginsFile;
    if (parsed.version !== 1 || typeof parsed.pending !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readPendingLogin(
  profile: Profile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PendingLogin | null> {
  const file = await readPendingLoginsFile(env);
  const entry = file?.pending[profile];
  if (
    entry === undefined ||
    typeof entry.authBaseUrl !== 'string' ||
    typeof entry.deviceCode !== 'string' ||
    typeof entry.expiresAt !== 'number'
  ) {
    return null;
  }
  return entry;
}

// Merge one profile's pending grant into the file (0600: the device code is
// redeemable for tokens once the human approves), or clear it when `pending`
// is null. Preserves the other profiles' entries.
export async function writePendingLogin(
  profile: Profile,
  pending: PendingLogin | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const existing = (await readPendingLoginsFile(env)) ?? { version: 1 as const, pending: {} };
  const entries = { ...existing.pending };
  if (pending === null) delete entries[profile];
  else entries[profile] = pending;
  await writeOwnerOnlyJson(pendingLoginFilePath(env), {
    version: 1,
    pending: entries,
  } satisfies PendingLoginsFile);
}

async function writeOwnerOnlyJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFile's `mode` applies only when it CREATES the file; an existing
  // file (an older CLI wrote it, or a permissive umask) keeps its old perms.
  // chmod unconditionally so a rewrite tightens a file that is already too
  // open, rather than leaving the secret group/world-readable.
  await chmod(path, 0o600);
}
