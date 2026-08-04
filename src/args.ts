// A minimal argv parser: no dependency, and small enough to unit-test the
// exact precedence the commands rely on. Supports `--flag value`,
// `--flag=value`, and boolean `--flag`; everything else is a positional.

export interface ParsedArgs {
  positionals: string[];
  // A flag present with no value (`--json`) stores `true`; a valued flag
  // (`--doc abc` / `--doc=abc`) stores the string.
  flags: Record<string, string | true>;
}

// Flags that never take a value, so `brass publish --yes ./dist` parses
// `./dist` as a positional rather than the value of `--yes`.
const BOOLEAN_FLAGS = new Set([
  'json',
  'yes',
  'help',
  'version',
  'stdout',
  'start',
  'check',
  'new',
]);

// Every flag any command reads. A flag outside this set is rejected rather
// than ignored, because ignoring one silently retargets the invocation: the
// origin flags default to production, so a misspelled `--api-ur1` publishes an
// app, or mints a sign-in, against the real platform while naming another
// stack on the command line.
const KNOWN_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  'api-url',
  'app',
  'auth-url',
  'client-token',
  'dashboard-url',
  'doc',
  'gate',
  'manifest',
  'name',
  'org',
  'out',
  'slug',
  'token',
  'visibility',
  'wait',
]);

// The flag names this CLI does not know, in the order given, for an error
// naming all of them rather than one per run.
export function unknownFlags(parsed: ParsedArgs): string[] {
  return Object.keys(parsed.flags).filter((name) => !KNOWN_FLAGS.has(name));
}

// Which of `names` were given without a value (`--api-url --json`, or
// `--api-url` last on the line). The parser stores those as `true` and
// `stringFlag` reads that as absent, so an origin flag in this state resolves
// the production default while the command line names another stack. That is
// the same silent retarget `unknownFlags` catches for a misspelled name.
export function valuelessFlags(parsed: ParsedArgs, names: readonly string[]): string[] {
  return names.filter((name) => parsed.flags[name] === true);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

// Read a flag expected to carry a string value; a bare boolean flag (no
// value) is treated as absent so `--doc` alone doesn't resolve to `true`.
export function stringFlag(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const v = parsed.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || typeof parsed.flags[name] === 'string';
}
