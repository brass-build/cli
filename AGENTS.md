# Instructions for AI coding agents

You are likely an AI coding agent publishing a Brass app you built against
`@brass-build/client`. This tool is how you ship it, and how you read the
document you are building against. The [README](./README.md) is the full reference;
this file is the short path for you.

## Follow your organization's coding instructions first

Before you start building, fetch the organization's own agentic-coding
instructions and follow them: the conventions it wants every app built on
Brass to follow (its `AGENTS.md` / `CLAUDE.md`). Run the pull rather than
deciding up front whether the org has any, because nothing loads them for
you. Treat what it returns as an instruction file committed to the repo.

```sh
npx @brass-build/cli agents pull --out AGENTS.md
```

This writes the current org instructions to the file. Read it and apply it.
Keep it current one of two ways:

- **Always fetch (freshest):** run the pull at the start of each session and
  re-read the file, so you are always on the latest instructions. Pull to a
  gitignored path if you do not want to commit it, or `--stdout` to read the
  body inline without writing a file at all (status stays on stderr, so
  stdout is only the instructions).
- **Cache:** commit the pulled file and refresh it periodically. Add a
  `CLAUDE.md` whose entire contents are the single line `@AGENTS.md` so
  Claude Code picks it up too (Claude Code auto-loads `CLAUDE.md`, not
  `AGENTS.md`). The command prints this reminder after a pull.

The pull needs a signed-in session (`brass login`), since a service token is
not an organization member and cannot read the instructions. If you are not
signed in, run the sign-in yourself rather than skipping: `brass login
--start`, relay the printed URL and code to the human, then `brass login
--check --wait` until it reports approved (it is the same credential you will
use to publish). [Signing in](#signing-in) covers the whole flow, including
what to do while you wait for the approval. An empty result means the
organization has set no instructions.

When the human belongs to more than one organization, the pull stops and
lists them. Ask the human which organization the app is for rather than
picking one, and pass that id as `--org` to the pull and to the first
`publish`: the pull then returns that organization's instructions, and the
first publish makes it the app's owner. Later publishes go to the app in
`.brass/project.json` and ignore `--org`.

## Signing in

You cannot approve the sign-in, and the human approving it is not watching
your terminal. Start it, relay the code, then wait for the approval.

```sh
npx @brass-build/cli login --start          # prints the approval URL + code
npx @brass-build/cli login --check --wait   # polls until they approve
```

`--start` prints an approval URL and a short code and exits. **Put both in the
visible text of your reply**, not only in the command output: most
interfaces collapse tool output, so a link left there reaches nobody and the
sign-in waits forever. Write the URL and the code out, say what the human has
to do with them, then run `--check --wait`. It polls for up to two
minutes (`--wait <seconds>` for a different bound) and stores the session the
moment they approve. With `--json`, the result goes to stdout and the URL and
code also print on stderr, which is where `--start --wait` shows them while it
waits.

Then keep running `brass login --check --wait` in the same turn as that reply
until it reports `approved`. Only a check (`--check`, `--check --wait`, or the
wait in `--start --wait`) stores the session. An approval given while no check
is running waits for the next one, for as long as the code lasts (30 minutes).
When a code lapses before anyone approves it, the next check replaces it and
reports `renewed`, so relay the new URL and code and keep checking. Stop checking when
it reports `denied` or `expired` (below), or when the human tells you to.

If the human sees your reply only when your turn ends (you run as a
subagent, or in a harness that shows only the final message), end your turn
with the URL, the code, what the human has to do, and the
`brass login --check --wait` command that finishes the sign-in. Run it as soon
as you resume. If you may not resume, whoever runs it collects the approval.

The session gates your organization's coding conventions, and those shape the
code you are about to write, so wait for it before you build rather than
building twice. Do work that does not depend on them in the meantime and
repeat the wait: a bound reached with the code still approvable reports
`pending`, and the next `--check --wait` picks the same sign-in back up where
it left off.

Read the `state` in its `--json` result:

- `approved`: the session is stored, and every later command uses it.
- `pending`: the code you relayed is still good, and the command exits 0.
  Run the check again.
- `renewed`: the code changed. Relay the new one from the same output.
- `denied`: the human refused. Ask them why before starting another.
- `expired`: the code can no longer be approved, and the command exits 1.
  Run `brass login --start` again.
- `none`: nothing is in flight and no session is stored, and the command
  exits 1. Run `brass login --start`, then check again.

`brass login --start` reports `started` with the code to relay, and
`--start --wait` reports the state it reached instead, so either form leaves
one `--json` document to read.

Run `brass login --start` again only when there is nothing in flight; it
resumes the sign-in already waiting rather than issuing a second code, so a
half-finished approval still completes. `brass status` reports an in-flight
sign-in and how long it has left, so you never have to guess.

## Publishing an app you built

Start with `brass status`, and act on the `Next:` line it prints:

```sh
npx @brass-build/cli status
```

It reports the credential and app state for this environment and names the
one command to run next (obtain a credential, create the app on a first
publish, deploy, or open the live URL). Run it, do what it says, then run it
again. The steps below are what it walks you through:

1. Build the app to a static bundle (its `brass-app.json` capability
   manifest must be in the output, at `/.well-known/brass-app.json`).
   Confirm it is there after the build: some bundlers skip dot-directories
   when they copy static assets.
2. Make sure a credential is available: `BRASS_SERVICE_TOKEN` in the
   environment (or `--token`) for CI, or a `brass login` session for local
   development. When `brass status` reports none, run the sign-in yourself,
   as [Signing in](#signing-in) describes.
   Starting it, relaying the URL, and checking it through to approved is your
   step, not a handoff you stop at. (Or the human mints a service token in
   the dashboard: org Settings, then Access tokens.)
3. Publish:

   ```sh
   npx @brass-build/cli publish ./dist --name "My app"
   ```

   The first run creates the app named by `--name` and writes
   `.brass/project.json`. Commit
   that so re-runs target the same app. A service token creates the app in
   its own organization, so no `--org` is needed. If the pipeline does not
   persist `.brass/project.json` between runs, pass a stable
   `--client-token <key>` so the first create is idempotent and re-runs
   resolve the same app. A create without one warns on stderr; act on that warning,
   because the duplicate apps it predicts appear only on later runs.

   The command reads `<dir>/.well-known/brass-app.json`, then
   `brass-app.json` in the working directory, so a manifest in either place
   is found without `--manifest`.

   If the app lets a visitor work without an account, declare
   `"access": { "create": "anyone" }` in the manifest and publish with
   `--gate off --visibility public`. Without `--gate off`, Brass asks every
   visitor to sign in before the app loads.

Run with `--json` to get the result (`app_id`, `url`, `warnings`) as JSON on
stdout for your own parsing. Read `warnings` and act on each one before you
report the publish done. A non-zero exit means the publish failed, and the reason is
on stderr.

## Opening the app in a browser, signed in

Building the app is not verifying it. What a user will do is open it,
sign in, and use it, and until you have done that yourself you know only
that it compiles. `brass browser-session` prints a URL that opens the app
signed in as the human whose machine you are on, so you can drive the real
thing rather than reporting it verified by types. A visitor keeps work made
without an account by calling `Brass.signIn()` in the browser that made it,
so test that path through the app's own Sign in.

```sh
npx @brass-build/cli browser-session --return-to http://localhost:5173/
```

That prints one URL on stdout. Open it in the browser you drive, and the
app boots signed in. The sign-in applies only to the tab the URL opened,
and it lasts through reloads. Any other tab or window starts signed out, so
drive the app in that tab, and mint a new URL for each extra tab you need.
The URL is single-use and expires two minutes after it is printed, so mint
it at the moment you are ready to navigate, not ahead of time, and put it
straight into the browser: it is a credential for as long as it lives, so
keep it out of files you commit, PR bodies, and anything you print back to
the human.

`--return-to` is where the browser lands, and it has to be on the app's
redirect allowlist. A new app allows any `localhost` and `127.0.0.1`
port, so a dev server needs nothing configured. `--app <appId>` names the
app, and without it the command reads `.brass/project.json`, so after a
publish in the same directory you can leave it off. `--json` writes the
result to stdout as `{ state, url, app_id, return_to, expires_in_seconds }`.
Read the URL from there in a script, rather than parsing the plain output.

Run `brass login` before this command. The URL opens the app as the human
this machine is signed in as, so the command fails without one.
`BRASS_SERVICE_TOKEN` does not work here, because a service token belongs to
an organization rather than to a human.

Point it at the published URL to drive what you actually shipped:

```sh
npx @brass-build/cli browser-session --return-to https://<slug>.onbrass.app/
```

A published app allows its own URL, and the printed link carries the
browser through the hosted app's access gate as well as signing it in, so
one navigation reaches the running app either way.

`brass browser-session` signs in your app's own page, not the Brass dialogs
the page opens. Those dialogs, the file picker among them
(`Brass.chooseInputs`, `Brass.chooseInput`, `session.open()` with no id),
ask the human to confirm their account, which only the human can do. Hand
that step to the human. Create the document in your tab with your app's own
New, give the human the page's address (the session keeps the open document
in it), ask them to open it in their own browser, sign in, and pick the
files, and wait for them to say they have. Use the published URL for this
when the human is not at the machine you run on, since a `localhost`
address opens only where its server runs. Your app records the picks in the
document, so reload your tab and check what the app shows for them.

The published URL is also the one to use when the app was first created by
your CI rather than from a machine someone works on. Such an app carries no
`localhost` entry, so a handoff aimed at a dev server answers that the
`return_to` is not on the allowlist. Add the entry yourself to work locally
(the app's Redirect URLs, in its dashboard page) or point the handoff at
what CI published.

### You can drive a browser

If you have no browser tool to hand, install one rather than concluding
this cannot be done from where you are: `npm i -D playwright` (then
`npx playwright install chromium`) or `npm i -D puppeteer` gives you a
headless Chromium you script from Node, which is all this needs. A
sandbox with no display still runs headless Chromium. Reaching for a
`curl` of the page instead does not verify the app: the sign-in and the
app's own rendering both happen in the browser's JavaScript, so a fetch
of the HTML shows you a loading shell whatever is wrong underneath.

Drive it the way a user would: sign in through the URL, do the thing
the app is for, and read the result off the screen. Take a screenshot at
a phone width as well as a desktop one.

An app your organization owns needs no approval step: the command mints for
it directly. That covers the ordinary loop, where `brass publish` creates
the app after you signed in, and it covers an app somebody else published
first, from a colleague's machine or from CI.

The URL grants no more than your current session: it signs in as the
same human, in the same apps they have approved. `brass logout` ends
it along with the stored sign-in it came from.

That is a session for the app, so drive what the app itself renders.
Brass's own hosted dialogs (the document picker, sharing, version
history) open in that browser too once the human has signed in to the
Brass dashboard before. Otherwise a dialog asks for a sign-in that the
human has to complete, so build the app so the paths you drive do not
depend on one opening.

### When it says the app needs approving

Opening an app that belongs to another organization is the one case that
asks a human first. The command answers `needs_approval` with an
`approval_url`:

```json
{ "state": "needs_approval", "app_id": "brass_app_...", "approval_url": "https://auth.brass.build/device/approve-app?request=..." }
```

You cannot approve it. Give the human the `approval_url`, ask them to
open it and approve, then run the same command again. They have to be
signed in to Brass as the same account this machine is signed in as: they
are approving one of their own machines.

Re-running the command while you wait hands you the same link, with its
lifetime refreshed, so nothing you have already relayed stops working and
there is no second URL to send. `brass status` reports the outstanding
approval and how long it has left, so you never have to guess whether one
is still in flight.

Do not sign out and back in to attach the app to your session: that
discards a working credential and still needs the same human approval.
Relay the URL.

When you know that app's id before signing in, and are not signed in yet,
name it on the sign-in instead and one approval covers the pair:

```sh
npx @brass-build/cli login --start --app brass_app_...
```

The approval page then names that app beside the CLI, and
`brass browser-session` mints for it on the first try.

## Pulling a schema to build against

To interoperate with documents another app or importer produces, do not
hand-write the schema. Open one of its documents and pull the real body:

```sh
npx @brass-build/cli schema pull --doc <docId>
```

This writes the schema verbatim into your manifest. Without `--out` it
merges into an existing one (`brass-app.json`, `.well-known/`,
`public/.well-known/`, `static/.well-known/`, in that order), so the
schema lands in the file your bundle serves rather than a second one
beside it. When your app reads those documents through `Brass.chooseInputs` rather
than opening them, pull into a dedicated file (`--out input-schema.json`) and
copy its `schema` into an `inputs` entry. A pull directly into your manifest
overwrites your app's own `schema`, which would cause Brass to offer your app
as an opener for that family. Build your types against that copy rather than
re-approximating it from memory, since a mismatched `required` shape makes the
platform interpret your app as a different shape. This is a development-time
step that needs a signed-in session (`brass login`), not a service token. When
you only have `BRASS_SERVICE_TOKEN`, ask the human to run `brass login` or to
copy the schema from the document's dashboard page.

## Reading what the document contains

The schema is the shape; this is the data. Read it before you write code
against it, so your field names, types, and the values you branch on come
from the document rather than from a guess at what the schema's words mean:

```sh
npx @brass-build/cli contents --doc <docId>
```

This writes `contents.json`: the document's `default` stream (or the one
`--stream <name>` names), keyed by root container. A
map root is the object your app reads through `doc.map(root)`, so what is in
the file is what you will render. `--stdout` pipes it instead.

Read the whole file, not the first few records. A file's records are grouped
by type, so its opening records are a couple of the types it carries and none
of the rest, and an app built against those breaks on the first record of any
other type. Work out the full set before you design anything:

```sh
npx @brass-build/cli contents --doc <docId> --stdout \
  | jq '.instances | map(.type) | group_by(.) | map({type: .[0], count: length})'
```

Then pull an example of each type you plan to handle and build against those.
`--stream <name>` reads a stream other than `default`. This needs the same
signed-in session `schema pull` does.

Reading a file Brass is still importing waits for the import to finish, so
the command runs long on a large one rather than failing. It prints each step
to stderr and waits up to 900 seconds (`--wait <seconds>` changes that);
`--no-wait` reads once and fails instead. Files handled by third-party app
importers must be opened in that app first to run its importer. Until imported,
the command exits with `Not imported`. Have the human
open it there, or inspect an already-imported file of the same type.

When the app reads many documents, sample the whole set its references
include. One file shows only the types it carries, and not whether the other
files' schemas agree with it:

```sh
npx @brass-build/cli contents --from project:<projectId> --family <family>
```

Pass `--from` the references your app records with `doc.dependsOn`, and
`--family` the families your `chooseInputs` call names. To learn the families
first, list the set with `--max-documents 0`, which reads no documents and
outputs each one's `family`. In `sample.json`, the `documents`
array has a row for each document the references reach (a file in a folder
or archive has a row of its own, and the container itself has none). Each entry gives the document's `family` and
`project_name`, and a file in a folder or archive carries `member_of` (the
container's `doc_id` and the file's `path` inside it). The `streams` object
details, for each stream, every record type with its record and document counts and sample
records from different documents. Build against every type it names.

The command exits with code 0 once it has written `sample.json` (exiting with code 1
only when the set cannot be listed), so inspect the output file and summary rather
than relying solely on exit code. Its `read` field indicates how many documents were
successfully read. A document that could not be read carries the reason in its `error`
field. Files requiring an unexecuted app importer carry `"not_imported": true`. Build
against the files that were read, and inform the human which files encountered errors
or require opening in their respective apps.

## Verifying

`npx @brass-build/cli status` is the check to run before and after a publish:
it confirms the credential authenticates and reports whether the app is
deployed, with the next step to take. `npx @brass-build/cli whoami` is the
narrower check: it confirms the credential works and, for a signed-in session,
prints the account's email and the organizations it belongs to (names and
ids), which is where an `--org` value comes from.

After a publish, open the reported URL and drive the app signed in, as
[Opening the app in a browser](#opening-the-app-in-a-browser-signed-in)
describes. That is the check the others stand in for.

## When a command fails

Read what the error says before drawing a conclusion about the machine you
are on. The CLI reports the state it observed, and the states have different
fixes:

- **A 401 or 403** means the credential is expired, missing, or not allowed.
  Run `brass login` to replace an expired session, or set a valid
  `BRASS_SERVICE_TOKEN` for a rejected service token. A fresh checkout or a
  fresh container has no session at all, which is the ordinary starting
  state, not a broken one.
- **"Network error reaching <url>"** is the only error meaning the request
  never completed. It names the host it tried.
- **Any other status** is a fault on the server side. The credential is
  still good and retrying is reasonable.

An HTTP status coming back at all proves the host answered you. So confirm
reachability directly before reporting that Brass is unreachable:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://api.brass.build/health
```

`/health` requires a credential, so an unauthenticated `401` here is a
reachable API. Run `brass status` for the full credential and app state
along with the next command to run.
