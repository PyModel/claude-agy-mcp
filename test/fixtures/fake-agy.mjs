#!/usr/bin/env node
// A stand-in agy executable for the stdio end-to-end suite. It speaks only the
// surface the bridge uses: --version, --help, `models`, and print mode with a
// JSON envelope. Behaviour is chosen by a marker in the prompt so one binary
// serves every case.
import { writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

if (argv[0] === "--version") {
  console.log("1.2.2");
  process.exit(0);
}
if (argv[0] === "--help") {
  console.log(
    [
      "--output-format --json-schema --mode --effort --disable-slash-commands --add-dir",
      "--conversation --print-timeout --log-file --sandbox --dangerously-skip-permissions",
      "--model -p",
    ].join("\n"),
  );
  process.exit(0);
}
if (argv[0] === "models") {
  console.log("gemini-3.8-flash-high\tGemini 3.8 Flash (High)");
  process.exit(0);
}

const prompt = valueOf("-p") ?? "";
const requested = valueOf("--conversation");
const envelope = (response, conversationId) =>
  JSON.stringify({
    conversation_id: conversationId,
    status: "SUCCESS",
    response,
    duration_seconds: 0.1,
    num_turns: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 2,
    },
  });

if (prompt.includes("@@SLEEP")) {
  // Record the pid so the suite can prove this process was reaped, then ignore
  // SIGTERM the way a busy agy mid-tool-call can, so only SIGKILL stops it.
  if (process.env.FAKE_AGY_PIDS) {
    writeFileSync(path.join(process.env.FAKE_AGY_PIDS, String(process.pid)), "");
  }
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (prompt.includes("@@FORK")) {
  console.log(envelope("answered from a new conversation", "forked-new"));
} else {
  console.log(envelope(`echo: ${prompt.slice(-60)}`, requested ?? "conv-e2e-1"));
}
