// A minimal argv parser: no dependency, and small enough to unit-test the
// exact precedence the commands rely on. Supports `--flag value`,
// `--flag=value`, and boolean `--flag`; everything else is a positional.

export interface ParsedArgs {
  positionals: string[];
  // A flag present with no value (`--json`) stores `true`; a valued flag
  // (`--doc abc` / `--doc=abc`) stores the string.
  flags: Record<string, string | true>;
  // Boolean flags written with a value (`--json=false`). A boolean flag is on
  // by being present, so any value behind one contradicts the flag itself, and
  // the reading a caller expects is the opposite of the one it would get.
  valuedBooleans: string[];
}

// Flags that never take a value, so `brass agents pull --stdout ./dir` parses
// `./dir` as a positional rather than the value of `--stdout`.
const BOOLEAN_FLAGS = new Set([
  'json',
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

// The flags every command reads, whichever it is: where to talk to and what
// to print.
const COMMON_FLAGS = [
  'api-url',
  'auth-url',
  'dashboard-url',
  'help',
  'json',
  'version',
] as const;

// What each command reads beyond those, and how many positionals it takes
// (the command word included, so `publish [dir]` is 2). A flag one command
// reads is not thereby a flag of the next: `--wait` is the sign-in poll's
// deadline and `publish` has its own, so `brass publish --wait 600` waits
// exactly as long as it would have without the flag. Refusing it names the
// mistake, where accepting it leaves the caller believing they set something.
const COMMAND_ARGS: Record<string, { flags: readonly string[]; positionals: number }> = {
  login: { flags: ['check', 'new', 'start', 'wait'], positionals: 1 },
  logout: { flags: [], positionals: 1 },
  status: { flags: ['app', 'manifest', 'token'], positionals: 2 },
  publish: {
    flags: [
      'app',
      'client-token',
      'gate',
      'manifest',
      'name',
      'org',
      'slug',
      'token',
      'visibility',
    ],
    positionals: 2,
  },
  schema: { flags: ['doc', 'out', 'token'], positionals: 2 },
  agents: { flags: ['org', 'out', 'stdout', 'token'], positionals: 2 },
  whoami: { flags: ['token'], positionals: 1 },
};

// The flags `command` does not read, out of the ones this CLI knows. A name
// the CLI knows nowhere is `unknownFlags`' answer and stays there, so a
// misspelling is reported as one rather than as a flag of another command.
// A command this CLI does not have answers for itself.
export function flagsNotReadBy(parsed: ParsedArgs, command: string): string[] {
  const spec = COMMAND_ARGS[command];
  if (spec === undefined) return [];
  const reads = new Set<string>([...COMMON_FLAGS, ...spec.flags]);
  return Object.keys(parsed.flags).filter(
    (name) => KNOWN_FLAGS.has(name) && !reads.has(name),
  );
}

// The positionals past the ones `command` reads. An ignored one is the same
// silence a flag no command reads leaves: `brass publish out dist` publishes
// `out`, and the caller who meant `dist` is told nothing.
export function extraPositionals(parsed: ParsedArgs, command: string): string[] {
  const spec = COMMAND_ARGS[command];
  if (spec === undefined) return [];
  return parsed.positionals.slice(spec.positionals);
}

// The flags of `command` that carry a value, so a bare one is the caller
// naming something the run then resolves a default for. `--wait` is absent
// here because a bare `--wait` is its own answer (the default deadline).
export function valueFlagsOf(command: string): string[] {
  const spec = COMMAND_ARGS[command];
  if (spec === undefined) return [];
  return [...COMMON_FLAGS, ...spec.flags].filter(
    (name) => !BOOLEAN_FLAGS.has(name) && name !== 'wait',
  );
}

// Which of `names` were given without a value (`--api-url --json`, or
// `--api-url` last on the line). The parser stores those as `true` and
// `stringFlag` reads that as absent, so an origin flag in this state resolves
// the production default while the command line names another stack. That is
// the same silent retarget `unknownFlags` catches for a misspelled name.
//
// An EMPTY value counts, and it is the shape a caller actually reaches: a
// script writing `--slug "$SLUG"` against an unset variable passes the flag
// with nothing behind it. That value is not absent the way a bare flag is, so
// it resolves no default and travels to the server as an empty string, where
// the mistake is reported (if at all) in the server's vocabulary rather than
// as the missing value it is.
export function valuelessFlags(parsed: ParsedArgs, names: readonly string[]): string[] {
  return names.filter((name) => {
    const value = parsed.flags[name];
    return value === true || value === '';
  });
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const valuedBooleans: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        const name = body.slice(0, eq);
        if (BOOLEAN_FLAGS.has(name)) {
          // Recorded rather than read: `--json=false` reads as ON, which is
          // the reverse of what the caller wrote, and `--stdout=false` would
          // send a file's contents to stdout and write nothing.
          valuedBooleans.push(name);
          flags[name] = true;
          continue;
        }
        flags[name] = body.slice(eq + 1);
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
  return { positionals, flags, valuedBooleans };
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
