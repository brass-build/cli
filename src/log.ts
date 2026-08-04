// A tiny logger the commands write through, so tests can capture output and
// a `--json` mode can suppress the human lines. Human status goes to stderr;
// stdout is reserved for machine-readable results (`--json`) so a pipeline
// can consume `brass ... --json | jq` without status noise on the same stream.

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  result(payload: unknown): void;
  // Raw payload write to stdout, verbatim (no added newline, no `--json`
  // gating). For a command whose primary output IS content a caller reads or
  // pipes (e.g. `agents pull --stdout`); status stays on stderr so stdout
  // carries only that content.
  write(text: string): void;
}

export function createLogger(json: boolean): Logger {
  return {
    info(message) {
      if (!json) process.stderr.write(`${message}\n`);
    },
    // Warnings survive `--json`, unlike status lines. `--json` reserves
    // STDOUT for the result, which a warning on stderr never touches, and the
    // caller most likely to act on one is a script or a coding agent running
    // in that mode. Suppressing it there loses the signal on the only path
    // that reads output mechanically.
    warn(message) {
      process.stderr.write(`warning: ${message}\n`);
    },
    success(message) {
      if (!json) process.stderr.write(`${message}\n`);
    },
    result(payload) {
      if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
    write(text) {
      process.stdout.write(text);
    },
  };
}
