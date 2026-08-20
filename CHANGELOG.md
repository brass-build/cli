# Changelog

All notable changes to `@brass-build/cli` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, minor releases may introduce breaking
changes.

## 0.3.0

### Changed

- `brass logout` keeps your credentials and exits non-zero when it cannot
  reach Brass, rather than clearing them and reporting success: only the
  stored record can name the session to end. Run it again once you have a
  connection. `--json` reports `signed_out: false`.
- `brass login --start --new` cancels the sign-in it replaces, so a code you
  already handed to someone stops working.

## 0.2.0

### Added

- `brass publish` waits for the platform to register the hosted slot before
  reporting success, and fails when it never registers. The slot reaches the
  serving edges shortly after that, so a URL the command reports can answer
  404 for a few seconds before it serves.

### Changed

- `brass logout` ends the sign-in on the server as well as on this machine, so
  a copy of the credentials file left elsewhere stops working. It also cancels
  a started sign-in this machine has not redeemed yet, so a code relayed to a
  human cannot be approved and spent afterwards. When Brass cannot be reached,
  the local credential is still cleared and the command says which half did not
  happen; `--json` carries this as `revoked`.
- `brass publish --gate` states the load gate when it enables hosting, so a
  publish that wants a world-loadable app no longer turns the gate on and
  straight back off.

## 0.1.0

Initial public release. The `brass` command-line tool publishes apps and
pulls schemas from a terminal or CI. Ships as an ESM-only package.
