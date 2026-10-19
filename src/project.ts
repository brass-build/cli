import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep, dirname } from 'node:path';
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

function projectStatePath(cwd: string): string {
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
// `/.well-known/brass-app.json`). The CLI writes `schema` on a `schema pull`
// and passes every other field through untouched. A first create also reads
// `name` and `client_token` from a manifest that carries them, for the apps
// whose pipelines already depend on that; the docs and the CLI's messages
// teach `--name` and `--client-token` instead, because the platform reads
// neither key from the manifest and a renamed `name` renames nothing.
export interface AppManifest {
  name?: string;
  // A stable, caller-chosen key that makes a first `publish` from CI
  // idempotent: with it, repeated create-from-scratch runs (ephemeral CI has
  // no persisted `.brass/project.json`) resolve the same app instead of
  // minting a duplicate. Committed in the repo, so it is the same across
  // runs. Opaque and non-secret (org-scoped; creating with it still needs the
  // caller's org authority).
  client_token?: string;
  // Inline, or `{ "$ref": "#/shared_schemas/<name>" }`.
  schema?: BrassSchemaManifest | { $ref: string };
  shared_schemas?: Record<string, unknown>;
  [key: string]: unknown;
}

// The manifest filename, and the bundle-relative directory the capability
// docs put it in.
export const MANIFEST_FILENAME = 'brass-app.json';
const WELL_KNOWN_DIR = '.well-known';

// Where `publish` and `status` look for the served manifest, most
// authoritative first. The copy inside the bundle is the one the platform
// reads back after a deploy, so it outranks the repo root, which is the flat
// layout an app that keeps its manifest beside `package.json` uses.
export function publishManifestCandidates(dir: string): string[] {
  return [join(dir, WELL_KNOWN_DIR, MANIFEST_FILENAME), MANIFEST_FILENAME];
}

// Where `schema pull` looks for a manifest to merge a pulled schema into.
// Source locations only: a bundler rewrites its output directory on the next
// build, so a schema written there is gone before the app is published. Each
// candidate is used only when it already holds a file, so a layout this list
// does not name falls back to the root default rather than being guessed at.
export function sourceManifestCandidates(): string[] {
  return [
    MANIFEST_FILENAME,
    join(WELL_KNOWN_DIR, MANIFEST_FILENAME),
    join('public', WELL_KNOWN_DIR, MANIFEST_FILENAME),
    join('static', WELL_KNOWN_DIR, MANIFEST_FILENAME),
  ];
}

// Absent means no file at this path, which is what lets a caller walk a
// candidate list. Every other failure throws: a manifest that exists and
// cannot be parsed is a mistake to report, and answering it with `null` drops
// the `name` and `client_token` it was written to carry, which reads as a
// missing manifest and creates a duplicate app on the next stateless run.
export async function readManifest(path: string): Promise<AppManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(`Could not read the manifest at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`The manifest at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The manifest at ${path} must hold a JSON object.`);
  }
  return parsed as AppManifest;
}

// The first candidate that holds a manifest, paired with the path it came
// from so a caller can name it. A candidate with no file is skipped; one that
// is present and unreadable throws out of `readManifest`, so a malformed
// manifest is reported rather than passed over for the next candidate down.
export async function loadFirstManifest(
  cwd: string,
  candidates: readonly string[],
): Promise<{ path: string; manifest: AppManifest } | null> {
  for (const candidate of candidates) {
    const manifest = await readManifest(resolve(cwd, candidate));
    if (manifest !== null) return { path: candidate, manifest };
  }
  return null;
}

// The first candidate that holds a file, without parsing it. `schema pull`
// picks its destination this way so it merges into a malformed manifest's
// path and fails there, instead of stepping over it and writing a second
// manifest the bundle never serves.
export async function firstExistingManifestPath(
  cwd: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await stat(resolve(cwd, candidate))).isFile()) return candidate;
    } catch {
      // Not there, or not reachable through this path. Try the next.
    }
  }
  return null;
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

const SCHEMA_REF_PREFIX = '#/shared_schemas/';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The `shared_schemas` name a position refers to, or null for an inline or
// absent schema.
function referencedName(value: unknown): string | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) return null;
  const ref = value['$ref'];
  return typeof ref === 'string' && ref.startsWith(SCHEMA_REF_PREFIX)
    ? ref.slice(SCHEMA_REF_PREFIX.length)
    : null;
}

function inputEntries(manifest: AppManifest): unknown[] {
  return Array.isArray(manifest['inputs']) ? manifest['inputs'] : [];
}

function importEntries(manifest: AppManifest): unknown[] {
  return Array.isArray(manifest['imports']) ? manifest['imports'] : [];
}

// Put a pulled schema manifest where the app's `schema` is, preserving every
// other field and their order. A `schema` that refers to a shared schema
// updates that shared schema, so the schema the app opens and the inputs
// that refer to it stay one definition, unless an `imports` entry and no
// `inputs` entry also uses it: then `schema` is written inline and the
// import keeps its schema. Any other `schema` is replaced inline.
// Pure, so the "copy verbatim" guarantee is testable: the declaration goes in
// unchanged, no re-derivation. Returns a new object.
export function mergeSchemaIntoManifest(
  manifest: AppManifest,
  schema: BrassSchemaManifest,
): AppManifest {
  const name = referencedName(manifest.schema);
  const shared = manifest.shared_schemas;
  const usedByAnImport = importEntries(manifest).some(
    (entry) => isPlainObject(entry) && referencedName(entry['schema']) === name,
  );
  const usedByAnInput = inputEntries(manifest).some((entry) => referencedName(entry) === name);
  if (
    name !== null &&
    isPlainObject(shared) &&
    Object.prototype.hasOwnProperty.call(shared, name) &&
    (usedByAnInput || !usedByAnImport)
  ) {
    return { ...manifest, shared_schemas: { ...shared, [name]: schema } };
  }
  return { ...manifest, schema };
}

// JSON with object keys sorted, so two schemas that differ only in key order
// compare equal.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

// The reasons a manifest cannot be published: an `inputs` entry that is a
// bare family word, a shared schema written as a
// `$ref`, a `$ref` that does not name a `shared_schemas` entry or sits beside
// other keys, an `imports` entry with a
// `schema` but no `extension` to apply it to, and two `imports` entries giving
// one extension different schemas, and an `access` block naming a key or a
// value Brass does not read. Checked before anything is uploaded, since
// the platform would otherwise drop or outvote what the manifest says.
export function manifestErrors(manifest: AppManifest): string[] {
  const shared = isPlainObject(manifest.shared_schemas) ? manifest.shared_schemas : {};
  const errors: string[] = [];
  const checkRef = (where: string, value: unknown): void => {
    if (!isPlainObject(value) || !('$ref' in value)) return;
    const ref = value['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) {
      errors.push(`${where}: "$ref" must read "${SCHEMA_REF_PREFIX}<name>"`);
    } else if (Object.keys(value).length > 1) {
      errors.push(`${where}: give "$ref" alone, or the schema inline, not both`);
    } else if (!Object.prototype.hasOwnProperty.call(shared, ref.slice(SCHEMA_REF_PREFIX.length))) {
      errors.push(`${where}: "shared_schemas" defines no "${ref.slice(SCHEMA_REF_PREFIX.length)}"`);
    }
  };
  for (const [name, definition] of Object.entries(shared)) {
    if (isPlainObject(definition) && '$ref' in definition) {
      errors.push(`shared_schemas "${name}": write the schema itself here, not a "$ref"`);
    }
  }
  checkRef('schema', manifest.schema);
  errors.push(...accessErrors(manifest['access']));
  inputEntries(manifest).forEach((entry, i) => {
    const where = `inputs entry ${i + 1}`;
    if (typeof entry === 'string') {
      errors.push(`${where}: write the schema of the documents you read, not the family "${entry}"`);
    }
    checkRef(where, entry);
  });
  const firstForExtension = new Map<string, { entry: number; schema: string }>();
  importEntries(manifest).forEach((entry, i) => {
    if (!isPlainObject(entry)) return;
    const where = `imports entry ${i + 1}`;
    const extension =
      typeof entry['extension'] === 'string'
        ? entry['extension'].trim().replace(/^\.+/, '').toLowerCase()
        : '';
    if (entry['schema'] !== undefined) {
      if (extension === '') errors.push(`${where}: a "schema" needs an "extension" to apply to`);
      checkRef(where, entry['schema']);
    }
    if (extension === '') return;
    const name = referencedName(entry['schema']);
    const resolved = name !== null ? shared[name] : entry['schema'];
    const schema = resolved === undefined ? '' : canonicalJson(resolved);
    const first = firstForExtension.get(extension);
    if (first === undefined) {
      firstForExtension.set(extension, { entry: i + 1, schema });
    } else if (first.schema !== schema) {
      errors.push(`${where}: entry ${first.entry} also names "${extension}" with a different schema`);
    }
  });
  return errors;
}

// Recursively collect a directory's files into fflate's zip input map, keyed
// by forward-slash relative path (zip entries never use the OS separator).
// Symlinks are followed via `stat`; empty directories are omitted (a static
// bundle has none that matter).
// The one entry name a zip built from an object map cannot carry. Assigning it
// on an ordinary object literal runs the prototype setter instead of adding an
// entry, and both this walk and fflate's own index are such maps, so the file
// drops out of the archive and the map inherits from the bytes it was handed.
// fflate then walks that index with `for...in`, reaches the inherited keys, and
// writes one bogus directory per byte of the file. Only the exact name at the
// root of the bundle does this: a `__proto__` inside a subdirectory is keyed by
// its whole relative path, which is an ordinary string.
const UNPUBLISHABLE_ENTRY_NAME = '__proto__';

export async function collectZipEntries(root: string): Promise<Record<string, Uint8Array>> {
  // Null-prototype, so the name above lands as an ordinary key and the refusal
  // below can see it. On a plain literal it is already gone by then.
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  // The real paths of the directories on the way down to `dir`, so a symlink
  // pointing back at one of its own ancestors ends the descent instead of
  // walking the subtree again at every level. `stat` resolves symlinks, so
  // without this the walk re-reads the whole subtree until the kernel refuses
  // the path at its symlink depth and the publish dies on a raw ELOOP naming a
  // path thousands of characters long. Only an ANCESTOR ends it: two separate
  // links to one directory are two real places to publish from, and each is
  // still walked.
  async function walk(dir: string, ancestors: readonly string[]): Promise<void> {
    const real = await realpath(dir);
    if (ancestors.includes(real)) return;
    const chain = [...ancestors, real];
    const names = await readdir(dir);
    for (const name of names) {
      const abs = join(dir, name);
      const info = await stat(abs);
      if (info.isDirectory()) {
        await walk(abs, chain);
      } else if (info.isFile()) {
        const rel = relative(root, abs).split(sep).join('/');
        entries[rel] = new Uint8Array(await readFile(abs));
      }
    }
  }
  await walk(root, []);
  if (UNPUBLISHABLE_ENTRY_NAME in entries) {
    throw new Error(
      `Cannot publish a file named "${UNPUBLISHABLE_ENTRY_NAME}" at the top ` +
        `level of ${root}: the archive format keys entries by name, and that ` +
        `name is an object's prototype rather than an entry. Rename or remove ` +
        `it.`,
    );
  }
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

const ACCESS_CREATE_VALUES: readonly unknown[] = [false, 'signed-in', 'anyone'];
const ACCESS_OPEN_VALUES: readonly unknown[] = ['signed-in', 'anyone'];

function accessErrors(access: unknown): string[] {
  if (access === undefined) return [];
  if (!isPlainObject(access)) return ['access: write an object with "create" and "open"'];
  const errors: string[] = [];
  for (const key of Object.keys(access)) {
    if (key !== 'create' && key !== 'open') {
      errors.push(`access: "${key}" is not an access setting; use "create" or "open"`);
    }
  }
  if (access['create'] !== undefined && !ACCESS_CREATE_VALUES.includes(access['create'])) {
    errors.push('access.create: write false, "signed-in" or "anyone"');
  }
  if (access['open'] !== undefined && !ACCESS_OPEN_VALUES.includes(access['open'])) {
    errors.push('access.open: write "signed-in" or "anyone"');
  }
  return errors;
}
