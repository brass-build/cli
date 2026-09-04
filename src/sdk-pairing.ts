// Which `@brass-build/client` this CLI is allowed to use.
//
// The dependency is pinned to one exact version, and what the CLI imports is
// the `internal` subpath, the entry that promises nothing from one release to
// the next. So the only copy it can run against is the one it names, and a
// correct install always provides it.
//
// What does not is a CLI running somewhere its own dependency is not
// reachable, and every way in is quiet. `npx brass` from a directory with no
// `node_modules` fetches the CLI alone from the registry. `npm i -g` nests a
// registry copy under the CLI. Installing the CLI tarball by itself resolves
// the SDK from npm, which succeeds precisely because an unreleased build in a
// working tree still carries the last released version number.
//
// The check is on the VERSION, not on any one export, and that is the point:
// a check per export is re-earned every time the CLI reaches for a new one,
// and it reports whatever that call happened to need rather than the pairing
// that is actually wrong. One version comparison covers every surface the CLI
// imports today and every one it adds later.

export interface LoadedSdk {
  version: string;
  // Which file answered. The version cannot identify a copy on its own: a
  // machine can hold several that all report the same one, which is exactly
  // the case here, so the path is what ends the search.
  path: string;
}

// The mismatch, as a sentence, or `null` when the pairing is sound.
//
// `loaded` is null when the SDK could not be resolved from the CLI's own
// location. That is not a mismatch: it is the shape an in-repo run takes,
// where the module specifier is mapped to the SDK's source and there is no
// installed package to read a version from. Being unable to check is not
// evidence of a fault, so it passes.
export function sdkMismatchMessage(args: {
  pinned: string | undefined;
  loaded: LoadedSdk | null;
}): string | null {
  const { pinned, loaded } = args;
  if (pinned === undefined || loaded === null) return null;
  if (loaded.version === pinned) return null;
  return (
    `This CLI is built against @brass-build/client ${pinned}, and the copy it ` +
    `loads is ${loaded.version} (${loaded.path}). It reads the SDK's internal ` +
    `entry, which changes between releases, so the two have to match. Install ` +
    `the CLI into the directory you run it from ("npm i @brass-build/cli") and ` +
    `run it as ./node_modules/.bin/brass with absolute paths: a global install ` +
    `keeps its own copy of the SDK, and npx resolves node_modules from the ` +
    `current directory, so it fetches one from the registry when run anywhere ` +
    `else.`
  );
}
