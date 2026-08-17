# Instructions for AI coding agents

You are likely an AI coding agent publishing a Brass app you built against
`@brass-build/client`. This tool is how you ship it and how you pull a
schema to build against. The [README](./README.md) is the full reference;
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
what to do while you wait for the approval. Pass `--org <organizationId>`
when the human belongs to more than one organization. An empty result means
the organization has set no instructions.

## Signing in

You cannot approve the sign-in, and the human approving it is not watching
your terminal. Start it, relay the code, then wait for the approval.

```sh
npx @brass-build/cli login --start          # prints the approval URL + code
npx @brass-build/cli login --check --wait   # polls until they approve
```

`--start` prints an approval URL and a short code and exits. Give both to the
human in your next message, then run `--check --wait`. It polls for up to two
minutes (`--wait <seconds>` for a different bound) and stores the session the
moment they approve. A code that lapses is replaced and the new one printed,
so the sign-in outlives any single code and a session started early is still
good at publish time.

The session gates your organization's coding conventions, and those shape the
code you are about to write, so wait for it before you build rather than
building twice. Do work that does not depend on them in the meantime and
repeat the wait: a bound reached with the code still approvable reports
`pending`, and the next `--check --wait` picks the same sign-in back up where
it left off.

Read the `state` in its `--json` result:

- `approved`: the session is stored, and every later command uses it.
- `pending`: the code you relayed is still good. Run the check again.
- `renewed`: the code changed. Relay the new one from the same output.
- `denied`: the human refused. Ask them why before starting another.
- `none`: nothing is in flight. Run `brass login --start` first.

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
   manifest must be in the output).
2. Make sure a credential is available: `BRASS_SERVICE_TOKEN` in the
   environment (or `--token`) for CI, or a `brass login` session for local
   development. When `brass status` reports none, run the sign-in yourself,
   as [Signing in](#signing-in) describes.
   Starting it, relaying the URL, and checking it through to approved is your
   step, not a handoff you stop at. (Or the human mints a service token in
   the dashboard: org Settings, then Service tokens.)
3. Publish:

   ```sh
   npx @brass-build/cli publish ./dist
   ```

   The first run creates the app and writes `.brass/project.json`. Commit
   that so re-runs target the same app. A service token creates the app in
   its own organization, so no `--org` is needed. If the pipeline does not
   persist `.brass/project.json` between runs, set a stable `client_token`
   (a `"client_token"` in `brass-app.json`, or `--client-token`) so the
   first create is idempotent and re-runs resolve the same app.

Run with `--json` to get the result (`app_id`, `url`) as JSON on stdout for
your own parsing. A non-zero exit means the publish failed, and the reason is
on stderr.

## Pulling a schema to build against

To interoperate with documents another app or importer produces, do not
hand-write the schema. Open one of its documents and pull the real body:

```sh
npx @brass-build/cli schema pull --doc <docId> --out brass-app.json
```

This writes the schema verbatim into your manifest. Build your types against
that copy rather than re-approximating it from memory, since a mismatched
`required` shape makes the platform read your app as a different shape. This
is a development-time step that needs a signed-in session (`brass login`),
not a service token. When you only have `BRASS_SERVICE_TOKEN`, ask the human
to run `brass login` or to copy the schema from the document's dashboard
page.

## Verifying

`npx @brass-build/cli status` is the check to run before and after a publish:
it confirms the credential authenticates and reports whether the app is
deployed, with the next step to take. `npx @brass-build/cli whoami` is the
narrower check when you only need to confirm the credential works. After a
publish, open the reported URL to confirm the app loads.

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
