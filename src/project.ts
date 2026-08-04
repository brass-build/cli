import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import type { BrassSchemaManifest } from './api.js';

// Local state the CLI persists so a re-`publish` targets the same app
// instead of creating a duplicate. Committed to the app's repo (like
// Vercel's `.vercel/project.json`), or supplied out-of-band via `--app` /
// `BRASS_APP_ID` for a stateless pipeline. Keyed by profile (`prod` / `dev` /
// `origin:<host>`) so one checkout can hold an app id per target.
export interface ProjectState {
  version: 1;
  apps: Record<string, { app_id: string }>;
}

const PROJECT_DIR = '.brass';
const PROJECT_FILE = 'project.json';

export function projectStatePath(cwd: string): string {
  return join(cwd, PROJECT_DIR, PROJECT_FILE);
}

export async function readProjectState(cwd: string): Promise<ProjectState | null> {
  try {
    const raw = await readFile(projectStatePath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as ProjectState;
    if (parsed.version !== 1 || typeof parsed.apps !== 'object' || parsed.apps === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeProjectAppId(
  cwd: string,
  profile: string,
  appId: string,
): Promise<void> {
  const existing = (await readProjectState(cwd)) ?? { version: 1 as const, apps: {} };
  const next: ProjectState = {
    version: 1,
    apps: { ...existing.apps, [profile]: { app_id: appId } },
  };
  await mkdir(join(cwd, PROJECT_DIR), { recursive: true });
  await writeFile(projectStatePath(cwd), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

// Resolve which app to publish to, most-explicit first: an inline `--app`,
// then `BRASS_APP_ID`, then the per-profile project state on disk. Null means
// "no app known yet" and the caller creates one.
export function resolveAppId(inputs: {
  flagApp?: string;
  envApp?: string;
  state: ProjectState | null;
  profile: string;
}): string | null {
  if (nonEmpty(inputs.flagApp)) return inputs.flagApp.trim();
  if (nonEmpty(inputs.envApp)) return inputs.envApp.trim();
  const stored = inputs.state?.apps[inputs.profile]?.app_id;
  return nonEmpty(stored) ? stored.trim() : null;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

// The served capability manifest an app authors (`brass-app.json` /
// `/.well-known/brass-app.json`). The CLI reads `name` for a first create
// (and `client_token` as its stable idempotency key), and writes `schema` on
// a `schema pull`; every other field is passed through untouched.
export interface AppManifest {
  name?: string;
  // A stable, caller-chosen key that makes a first `publish` from CI
  // idempotent: with it, repeated create-from-scratch runs (ephemeral CI has
  // no persisted `.brass/project.json`) resolve the same app instead of
  // minting a duplicate. Committed in the repo, so it is the same across
  // runs. Opaque and non-secret (org-scoped; creating with it still needs the
  // caller's org authority).
  client_token?: string;
  schema?: BrassSchemaManifest;
  [key: string]: unknown;
}

export async function readManifest(path: string): Promise<AppManifest | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as AppManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(path: string, manifest: AppManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// Write raw UTF-8 text to a file, creating parent directories as needed.
// Content is written verbatim (no added trailing newline) so a pulled
// document round-trips byte-for-byte with what the server stored.
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

// Set the manifest's `schema` to a pulled schema manifest, preserving every
// other field and their order. Pure so the "copy verbatim" guarantee is
// testable: the declaration goes in unchanged, no re-derivation. Returns a
// new object.
export function mergeSchemaIntoManifest(
  manifest: AppManifest,
  schema: BrassSchemaManifest,
): AppManifest {
  return { ...manifest, schema };
}

// Recursively collect a directory's files into fflate's zip input map, keyed
// by forward-slash relative path (zip entries never use the OS separator).
// Symlinks are followed via `stat`; empty directories are omitted (a static
// bundle has none that matter).
export async function collectZipEntries(root: string): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir);
    for (const name of names) {
      const abs = join(dir, name);
      const info = await stat(abs);
      if (info.isDirectory()) {
        await walk(abs);
      } else if (info.isFile()) {
        const rel = relative(root, abs).split(sep).join('/');
        entries[rel] = new Uint8Array(await readFile(abs));
      }
    }
  }
  await walk(root);
  return entries;
}

export function zipEntries(entries: Record<string, Uint8Array>): Uint8Array {
  if (Object.keys(entries).length === 0) {
    throw new Error('No files found to publish');
  }
  return zipSync(entries);
}

export async function zipDirectory(root: string): Promise<Uint8Array> {
  return zipEntries(await collectZipEntries(root));
}

// A deterministic hash of a bundle's contents: sha256 over the sorted
// `path\0sha256(bytes)` line of every file. It is derived from the SAME file
// map `zipDirectory` uploads (`collectZipEntries`), so equal hashes mean the
// served bytes would be identical, and it hashes file contents rather than the
// zip bytes (a zip carries mtimes and so is not reproducible for identical
// input). `publish` records this on the version it uploads and skips the
// upload + unpack-wait when the app's active version already carries it.
export function contentHash(entries: Record<string, Uint8Array>): string {
  const lines = Object.keys(entries)
    .sort()
    .map((path) => `${path}\0${createHash('sha256').update(entries[path]!).digest('hex')}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
