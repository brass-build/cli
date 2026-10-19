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
  // The app named by `brass login --app`, carried so a grant this CLI renews
  // in place asks for the same approval the relayed one did.
  targetAppId?: string;
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

// An app approval `brass browser-session` asked for and no one has granted
// yet. Recorded for the same reason a pending sign-in is: the caller relayed a
// URL to a human and now has to wait, and `brass status` is where it asks what
// is outstanding. Without it, status reports the app as ready and names a next
// step that is not the blocked one.
//
// One per profile, carrying the app it is for, so status reports it only
// against the app it resolved. A second app asked about while a first is
// pending overwrites it; the link it replaces stays valid on the server, and
// re-running the command for that app reports it again.
export interface PendingApproval {
  appId: string;
  approvalUrl: string;
  authBaseUrl: string;
  expiresAt: number;
}

interface PendingApprovalsFile {
  version: 1;
  pending: Record<Profile, PendingApproval>;
}

function pendingApprovalFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsFilePath(env)), 'pending-approval.json');
}

async function readPendingApprovalsFile(
  env: NodeJS.ProcessEnv,
): Promise<PendingApprovalsFile | null> {
  try {
    const raw = await readFile(pendingApprovalFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as PendingApprovalsFile;
    if (parsed.version !== 1 || typeof parsed.pending !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readPendingApproval(
  profile: Profile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PendingApproval | null> {
  const entry = (await readPendingApprovalsFile(env))?.pending[profile];
  if (
    entry === undefined ||
    typeof entry.appId !== 'string' ||
    typeof entry.approvalUrl !== 'string' ||
    typeof entry.expiresAt !== 'number'
  ) {
    return null;
  }
  return entry;
}

// The approval URL names a question rather than carrying a credential (the
// page still gates on the reader's own cookie), but the file is written
// owner-only like its siblings: what it discloses is which machine is asking
// about which app.
export async function writePendingApproval(
  profile: Profile,
  pending: PendingApproval | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const existing = (await readPendingApprovalsFile(env)) ?? { version: 1 as const, pending: {} };
  const entries = { ...existing.pending };
  if (pending === null) delete entries[profile];
  else entries[profile] = pending;
  await writeOwnerOnlyJson(pendingApprovalFilePath(env), {
    version: 1,
    pending: entries,
  } satisfies PendingApprovalsFile);
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
