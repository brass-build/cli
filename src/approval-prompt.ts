// The one rendering of an approval a human has to give: the URL to open, the
// code to confirm where there is one, plus what to do next. Every phase of the
// sign-in prints through here, so a fresh grant, a resumed one, and a renewed
// one read the same, and so does the app approval `brass browser-session`
// asks for, which is the same request with a different subject.
//
// Whether the reader is the person who approves decides whether the block
// needs a relay instruction, and the caller narrows it: `brass login` blocks
// until approval, so whoever ran it is waiting to approve, while `--start` /
// `--check` exist for a caller that cannot hold a command open, which is
// usually an agent. Usually, not always, so the note there is addressed to an
// agent as a condition rather than asserted about the reader, and a person
// running `--start` themselves reads past it.
//
// The caller is what narrows it because `isTTY` answers the wrong question
// twice: an agent harness that allocates a pty (many do, for colored output)
// reads as a watched terminal, and `brass login | tee` reads as an agent.
//
// The frame is ASCII: this goes to whatever console the caller has, and a
// box-drawing character that renders as a replacement glyph costs more
// prominence than the frame buys.

const RULE = '='.repeat(64);

export interface ApprovalPromptInput {
  /** Where the human approves, user code prefilled where the server offers it. */
  url: string;
  /** The code they confirm on that page, for a request that carries one. An
   *  app approval names the app on its own page instead, so it has none. */
  code?: string;
  /** What the reader is being asked to approve. Defaults to the device grant,
   *  which is what most of these are. */
  heading?: string;
  /** Why this prompt is showing again, when it is not the first time. */
  lead?: string | null;
  /** The command that finishes the sign-in, for a caller that exits before
   *  approval. A blocking sign-in polls on its own and passes the line it
   *  waits under instead. */
  nextCommand?: string | null;
  /** What a caller with no command to name says under the block. */
  closing?: string | null;
  /** Set by the flow a caller who cannot approve is the usual reason to run
   *  (`--start` / `--check`), which adds the note asking an agent to pass the
   *  link on. The blocking `brass login` leaves it unset: whoever ran it is
   *  waiting to approve. */
  relaying?: boolean;
}

export function renderApprovalPrompt(input: ApprovalPromptInput): string {
  const lines: string[] = [];
  if (input.lead) lines.push(input.lead, '');
  lines.push(
    RULE,
    input.heading ?? ' To approve this sign-in, open this link and confirm the code:',
    '',
    `   ${input.url}`,
  );
  if (input.code) lines.push(`   Code:  ${input.code}`);
  if (input.relaying === true) {
    lines.push(
      '',
      input.code
        ? ' If you are an AI agent, put the link and the code directly in your'
        : ' If you are an AI agent, put the link directly in your',
      ' reply. The person who approves often cannot see this output.',
    );
  }
  lines.push(RULE);
  if (input.nextCommand) {
    lines.push('', `Then run \`${input.nextCommand}\` to finish signing in.`);
  } else if (input.closing) {
    lines.push('', input.closing);
  }
  return lines.join('\n');
}
