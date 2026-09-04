# @brass-build/cli

From a terminal or a CI pipeline, the `brass` command publishes a Brass
app's built bundle and reads the documents you build against. It wraps the same data API the
dashboard uses, authenticated by a token instead of a browser session, so
the whole publish workflow runs unattended.

## Install

No install step. Run it with `npx`:

```sh
npx @brass-build/cli publish ./dist
```

## Authenticate

Two kinds of credential, for two audiences:

- A **signed-in session** from `brass login` is the developer credential.
  It opens your browser, you approve once, and the CLI stores the session
  under `~/.config/brass/`. It authorizes everything, including `schema pull`.
- A **service token** (mint one in the dashboard: org Settings, then Service
  tokens) is the CI credential, supplied as `BRASS_SERVICE_TOKEN`. It
  authorizes `publish` and `whoami`. It is an org-scoped machine identity,
  so it cannot fetch schemas.

```sh
npx @brass-build/cli login                  # developer: sign in with your browser
export BRASS_SERVICE_TOKEN=brass_sk_...     # CI: a pipeline secret
```

`login` opens your browser to an approval page showing a short code, prints
the same URL and code to the terminal, and completes on its own once you
approve. Confirm the code on the page matches the one in your terminal, then
approve. On a machine with no browser (a remote box, an SSH session), open the
printed URL from any other device.

For automation that cannot hold a command open while you approve (an AI
agent driving the sign-in), the flow splits in two: `brass login --start`
prints the approval URL and code and exits immediately, and
`brass login --check` checks that sign-in, storing the session once you have
approved. Add `--wait` to poll until you approve, for two minutes by default
or `--wait <seconds>` for a different bound. A code that lapses inside the
wait is replaced and the new one printed, so a sign-in started long before it
is needed still completes. Reaching the bound with the code still good is
reported as `pending` and exits 0, so the next check picks the same sign-in
back up. A second `--start` resumes the sign-in already waiting instead of
issuing a second code, and `--new` overrides that when you have lost the
first. Both phases honor `--json` for a machine-readable result on stdout.

The CLI picks a credential most-explicit first: `--token <token>`, then
`BRASS_SERVICE_TOKEN`, then the stored `brass login` session. `brass logout`
ends that session on the server and forgets it here. It keeps the stored
session and exits non-zero when it cannot reach Brass, so a retry can still
name the session to end.

```sh
export BRASS_SERVICE_TOKEN=brass_sk_...
npx @brass-build/cli whoami
```

## Opening your app signed in

`browser-session` prints a single-use URL that opens your app as you, for a
browser an automated tool is driving:

```sh
npx @brass-build/cli browser-session --return-to http://localhost:5173/
```

It exists for coding agents, which have no browser session of their own and
otherwise cannot check that what they built works for a signed-in user. If you
are at your own machine, opening the app in your own browser does the same
thing with fewer steps. `AGENTS.md` in this package documents the flow,
including what to do when the app has not been approved for this machine yet.

## Status

`status` reports the credential and app state for the target environment and
the one command to run next:

```sh
npx @brass-build/cli status
```

It confirms whether your credential authenticates, whether an app id is
resolved for this directory, and whether that app is deployed, then prints a
`Next:` line naming the exact next step (sign in, publish to create the app,
deploy, or open the live URL). When a `brass login --start` sign-in is waiting
for approval, it reports the code, the approval URL, and how long the code has
left. Run it before a publish to see what will happen, and after one to
confirm the app is live. `whoami` is the narrower check when you only need to
know the credential works. Add `--json` for the machine-readable result on
stdout.

## Publish

`publish` deploys a built static bundle to the app's Brass hosting
(`https://<slug>.onbrass.app`):

```sh
npx @brass-build/cli publish ./dist
```

On the first publish with no app yet, it creates one (using `--name`, or the
`name` in `brass-app.json`) and records the new app id in `.brass/project.json`
so later publishes target the same app. Commit that file, or pin the app
explicitly with `--app <appId>` or `BRASS_APP_ID` for a stateless pipeline.

For a pipeline that stands the app up from scratch and does not persist
`.brass/project.json` between runs, set a stable `client_token` (a
`"client_token"` in `brass-app.json`, or `--client-token`). Repeated first
publishes then resolve the same app instead of creating a duplicate each run.
A create that carries no `client_token` says so on stderr, since the duplicate
it can produce shows up only later. A service token creates the app in its own
organization, so no `--org` is needed.

The command enables hosting if needed, uploads the bundle, waits for the
platform to register the slot, and reports the URL. The URL can answer 404
until the slot reaches the serving edges, so reload if the first request
misses. The platform reads your app's capabilities
(`opens` / `creates` / `schema`) from the `/.well-known/brass-app.json` you
serve, so keep that manifest in the bundle.

Without `--manifest`, the command reads `<dir>/.well-known/brass-app.json`
and falls back to `brass-app.json` in the working directory, so the manifest
you ship at `/.well-known/` is found where it already sits. A manifest that is
present and cannot be parsed fails the publish, naming the file.

Flags: `--app`, `--name`, `--org` (organization to own a newly created app;
defaults to a service token's own org), `--client-token` (stable idempotency
key for a first create), `--slug` (preferred subdomain), `--manifest` (a
manifest path, overriding the search above), `--visibility` (`private`,
`invitee_visible` or `public`), `--gate` (`on` or `off`, the hosted load
gate).

## Pull a schema

To build against a shape another app or importer produces, open one of its
documents and copy its schema into your manifest:

```sh
npx @brass-build/cli schema pull --doc <docId>
```

This writes the document's schema body verbatim into the manifest's `schema`
field, preserving everything else. That is the same copy-verbatim step the
SDK's schema guide describes, done for you.

Without `--out` it merges into an existing manifest, checking
`brass-app.json`, `.well-known/`, `public/.well-known/` and
`static/.well-known/` in that order, and writes `brass-app.json` when it finds
none. It never writes into a build output directory, where the next build
would drop it.

Pulling a schema is a development-time action that needs a signed-in session
(`brass login`), since a service token cannot fetch schemas.

## Read what a document holds

A schema says what shape the records take; to get the records themselves,
write the document out as JSON:

```sh
npx @brass-build/cli contents --doc <docId>
```

This writes `contents.json` (`--out <path>` for somewhere else, `--stdout` to
pipe it). The file is the whole document, keyed by root container: a map root
is the object your app reads through `doc.map(root)`, a list root its items,
in the same shapes your code will see.

The whole document, not a sample. A file's records are grouped by type, so any
slice off the front carries a couple of the types it holds and none of the
rest; with the file on disk you can count the types, pull an example of each,
or filter to one, and every answer covers everything the document has:

```sh
npx @brass-build/cli contents --doc <docId> --stdout \
  | jq '.instances | map(.type) | group_by(.) | map({type: .[0], count: length})'
```

Brass fetches the document the way an app does, as the compact CRDT snapshot
plus the ops after it, and unpacks it here, so the download stays small
whatever the file's size. `--stream <name>` reads a stream other than
`default` and `--branch <id>` a branch other than the default. Like
`schema pull`, this needs a signed-in session (`brass login`).

Reading a file Brass is still importing waits for the import to finish, and
reports each step it moves through. `--wait <seconds>` moves the deadline
(900 by default) and `--no-wait` reads once and fails instead.

## Pull your organization's agent instructions

If your organization manages a shared set of agentic-coding instructions (its
AGENTS.md / CLAUDE.md), pull the current body into your repo:

```sh
npx @brass-build/cli agents pull --out AGENTS.md
```

Brass stores the instructions once at the organization level (admins edit
them on the dashboard Settings tab) so every developer's coding agent works
from one source of truth. The pull writes the body verbatim, so it
round-trips byte-for-byte with what the dashboard stored. Pass
`--org <organizationId>` when you belong to more than one organization. This
needs a signed-in session (`brass login`), since a service token is not an
organization member and cannot read the instructions.

Pass `--stdout` instead of `--out` to print the instructions to stdout
without writing a file (status goes to stderr, so stdout carries only the
body). This is the always-fetch path: a coding agent reads the current
instructions inline each session and caches nothing.

The default `--out` is `AGENTS.md`, the cross-agent convention that Cursor,
Codex, and others read. **Claude Code reads `CLAUDE.md`, not `AGENTS.md`**, so
to use these instructions there either pull straight to it
(`agents pull --out CLAUDE.md`) or add a `CLAUDE.md` that imports the pulled
file with a single line, `@AGENTS.md`. The command prints this reminder
whenever you pull to any file other than `CLAUDE.md`.

## CI example

```yaml
- run: npm ci && npm run build
- run: npx @brass-build/cli publish ./dist
  env:
    BRASS_SERVICE_TOKEN: ${{ secrets.BRASS_SERVICE_TOKEN }}
```

The service token creates the app in its own organization on the first run.
Give your `brass-app.json` a stable `"client_token"` so that first create is
idempotent (repeated runs resolve the same app rather than duplicating it),
or commit `.brass/project.json` to pin the app id. A run with neither creates
a new app each time, and warns that it did.

Add `--json` to any command to emit the machine-readable result on stdout
(human status stays on stderr).
