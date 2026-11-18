// Removes AI attribution lines from a commit message. Used two ways:
//  - imported by worktree-service.ts (to detect them),
//  - run by `git filter-branch --msg-filter` (message on stdin, cleaned message on stdout).
// Plain JS on purpose so git can run it with node directly.

/** Trailer/footer lines AI CLIs add to commit messages. */
export const AI_TRAILER_LINE =
  /^\s*(co-authored-by:.*(claude|cursor|anthropic|openai|copilot|gemini|\bai\b).*|made with cursor.*|🤖 generated with.*|generated with \[?claude code.*|claude-session:.*)\s*$/i;

export function stripAiLines(message) {
  const kept = message
    .split("\n")
    .filter((line) => !AI_TRAILER_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${kept}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => process.stdout.write(stripAiLines(input)));
}
