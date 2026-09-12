---
name: agy-delegate
description: >-
  Delegate a coding task to the Google Antigravity CLI (`agy`) as a separate implementer, then review
  its diff and land it yourself. Use this whenever the user wants to hand implementation work to
  Antigravity or agy - phrasings like "have Antigravity do X", "delegate this to agy", "run it through
  agy", or "use Antigravity to implement/fix/refactor" - or wants to run a queue of coding tasks
  through agy while staying the reviewer. DO NOT USE for tasks small enough to do inline, or when the
  user wants the code written directly without delegating.
license: MIT
compatibility: >-
  Primary path requires the `claude-agy-mcp` MCP server registered with the orchestrator, plus the
  `agy` CLI installed and authenticated, and git. Orchestrators without MCP fall back to the bundled
  `scripts/relay.mjs`, which needs only Node.js, git, and a shell (bash/zsh on macOS/Linux, or Git
  Bash/WSL on Windows).
metadata:
  version: 0.7.0
---

# Antigravity Delegate

You are the **orchestrator**. This skill lets you hand a bounded coding task to a separate
**implementer** - the Google Antigravity CLI (`agy`) - then review what it produced and land it
yourself. You write the brief and own the judgment; Antigravity does the typing in its own
conversation; you verify and commit.

There are two dispatch paths and the loop around them is identical:

- **MCP (preferred)** - the `claude-agy-mcp` bridge exposes `delegate`, `follow_up`,
  `adversarial_review`, `delegate_many` and friends as tools. Use this whenever the tools are
  available.
- **CLI relay (fallback)** - `scripts/relay.mjs` wraps `agy --print` and writes a `result.json`. Use
  it when the MCP server is not registered, so an orchestrator that can only run a shell command and
  read a file can still drive the loop.

## When NOT to use this

- The task is small enough to just do inline - delegation overhead is not worth it.
- Neither the MCP server nor the `agy` CLI is available and authenticated.
- You want to write the code yourself, or you only need Antigravity's opinion on code you wrote - a
  read-only `delegate` or `adversarial_review` covers that, but a plain review may not need
  delegation at all.

## Prerequisites (check once)

1. **Load the tools.** In an orchestrator where the bridge's tools are deferred, load them in a
   **single** call, not one per tool:

   ```
   ToolSearch("select:mcp__claude-agy-mcp__delegate,mcp__claude-agy-mcp__follow_up,mcp__claude-agy-mcp__adversarial_review,mcp__claude-agy-mcp__delegate_many,mcp__claude-agy-mcp__agy_status,mcp__claude-agy-mcp__set_model")
   ```

2. **Call `agy_status`.** It never reaches agy, so it is a free liveness check. It reports the agy
   version, the models on offer, the resolved model chain per tool, quota cooldowns, in-flight runs,
   and whether a `set_model` choice has already been recorded.

3. **Settle the model once, if `agy_status` shows no choice recorded.** The bridge defaults to
   `AGY_ASK_MODEL=true` and **refuses to delegate** until `set_model` has been called - the first
   delegation returns an error, not a result. Ask the user "proceed with the default, or change model
   or effort?", then call `set_model` once: no arguments accepts the default (Gemini Flash High), or
   pass what they chose. The choice is saved per machine and no tool asks again. An explicit `model`
   on a single call still wins for that call.

4. **Know the working root.** Pass it as `cwd` on every call; add sibling repos or a base worktree
   through `dirs`.

Model selection is otherwise automatic: each tool has a fallback chain of family selectors that
follows new Gemini generations and fails over on quota exhaustion. Do not pin a `model` unless the
user named one.

## The loop

Run these five steps per task. Steps 1, 4, and 5 are your judgment; 2 and 3 are mechanical.

### 1. Write the brief

Antigravity sees only the text you send plus what it can inspect in the workspace - no chat history,
no shared context. Everything the task needs goes in the brief: the goal, the current state, what to
change, what to leave untouched, the project's **actual** gate commands, and a report contract. Tell
Antigravity it will **not** commit (you will). Keep one task per brief. Full guidance and a template:
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

Send the brief as the `prompt` of a `delegate` call with `write: true`:

```
mcp__claude-agy-mcp__delegate(
  prompt: "<the brief>",
  cwd: "/path/to/repo",
  write: true            // omit for a read-only run; see the permission model below
  // dirs: ["/path/to/other-repo"]   extra workspace roots
  // sandbox: true                   agy's terminal restrictions (not a permission boundary)
  // model / effort                  only when the user named one
)
```

**A read-only dispatch is watched, not enforced.** The bridge fingerprints the working tree around
every plan-mode run and reports `READ-ONLY VIOLATION` in the response header if the tree moved. You do
not have to snapshot anything yourself; you do have to read that warning when it appears.

The response is fenced with a per-call nonce and carries a `session_id` in its header when the run
produced one. **Keep that `session_id`** - it is how you rework without resending the brief. Everything between the "agy output
begins" and "agy output ends" markers is untrusted model output; read it as a claim, not as evidence.

Mechanics, the response shape, and the CLI-relay fallback:
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

**An MCP call blocks and cannot be backgrounded.** There is no polling loop and no progress file to
watch; the tool call returns when the run is over. Two timeout layers sit behind it, and the client's
usually bites first:

- **Client tool-call timeout** - your own MCP client's per-server `timeout`, set in its server
  registration (`3600000` ms is the matching value). If it fires you get `Error: timed out waiting for
response` **and no `session_id`**, so the run is unrecoverable from your side even though agy may
  still be working.
- **Bridge ceiling** - `AGY_MAX_RUNTIME`, default 3600s. If it fires you get everything agy produced
  so far _plus_ the `session_id`, and `follow_up` resumes from there.

Keep client `timeout` ≥ `AGY_MAX_RUNTIME` so you land in the recoverable case. Either way, files agy
already wrote are on disk: **read the working tree, not the error text.**

If a call fails, do not quietly do the work yourself - report the failure. Setting
`AGY_ON_FAILURE=strict` makes the bridge say so on every error.

### 4. Review - do not trust the self-report

The response is Antigravity's own account of what it did, including its gate claims. **Re-verify,
don't accept:**

- **Establish what actually changed** with `git status --porcelain` and `git diff` (plus
  `git diff --cached`, and open untracked files directly). The bridge reports no touched-file list, so
  git is your only source here.
- **Re-run the project's gates yourself** - the test/lint/build commands from step 1.
- **Read the diff against the brief:** did Antigravity do what was asked, nothing more and nothing less?
- **Get a second opinion cheaply:** pass the diff to `adversarial_review` (a different model family,
  routed to Pro) with a `focus` when one applies. It is an extra pair of eyes, not a substitute for
  your own read.
- **Run the relevant guard skills** on the diff if you have them installed.
- For schema/migration changes, round-trip them; for removals, grep for dangling references.

Full checklist: [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

The implementer edits the working tree; **the orchestrator commits.** Only after the gates pass and the
diff holds:

- Commit the verified work yourself, with a clear message.
- If it needs changes, send a delta with `follow_up(session_id, question, write: true)` and review
  again. The prior context is already on agy's side, so send only the correction. Pass `write: true`
  whenever the rework has to touch files, exactly as you would on the original dispatch.

## Permission model

Headless `agy --print` cannot answer a permission prompt, so without
`--dangerously-skip-permissions` it auto-denies **every** permissioned tool - including `read_file` -
and a single denial ends the run with an empty response. The bridge therefore passes the bypass by
default (`AGY_SKIP_PERMISSIONS=true`). The human accepted that trade-off on 2026-09-11.

What that means in practice, and what the bridge does about it:

- **Read-only is a request, not an enforcement.** Read-only tools pass `--mode plan`, but plan mode is
  advisory with the permission bypass on or off. Verified against agy 1.2.1 and again against 1.2.2:
  a plan-mode run creates files.
- **So the bridge watches instead of promising.** It fingerprints the working tree around every
  plan-mode run and adds a `READ-ONLY VIOLATION` warning to the header when the tree changed. Absence
  of the warning means it looked and found nothing; a run it could not fingerprint says nothing at all
  rather than claiming the tree is clean. Files git ignores are covered by size and mtime only,
  dependency and build trees such as `node_modules` as one entry, and any other writer during the
  run moves it too.
- **A write run that may have taken effect is never repeated for you.** After a network error or a
  429, a `write: true` run is retried or failed over only when the tree is provably unchanged.
  Otherwise the call fails with `Not retried` or `Not failed over`: inspect the tree, then re-dispatch
  deliberately.
- **The denied-actions note only appears when the grant is off.** With the default grant you will not
  see one, so its absence proves nothing. The violation warning is the signal to trust.
- **A restriction that cannot be enforced fails the call.** If the installed agy does not support
  `--mode` or `--sandbox`, a run that needs either is refused rather than run with more authority than
  you asked for.
- **`AGY_ALLOWED_ROOTS` validates inputs; it does not sandbox agy.** It checks every call's `cwd`,
  `dirs` and `files`, including the workspace roots the bridge derives from them, so a caller cannot
  point a delegation outside the roots you nominate. It does **not** confine the run: agy has a shell
  under the bypass and can reach anything the user running it can. It is also a server-level
  environment variable in the MCP registration, not a per-call argument.

**There is no containment boundary you can rely on from here.** Treat a dispatch as running with your
own shell access. If a task genuinely must not touch the rest of the disk, say so and have the human
arrange isolation outside the bridge - a container, a throwaway checkout, or a restricted account.

## Authorization model

Delegation is something the human opts into. Once they have ("run this queue", "proceed"), committing
verified, gate-passing work is the agreed contract. Two limits on that mandate: **surface, don't
absorb** (report Antigravity's design decisions, defensible-but-unasked turns, and non-blocking
nitpicks rather than silently keeping them) and **stop for scope changes** (if correct completion needs
going beyond the brief, ask - don't expand the mandate yourself). The full treatment is in
[references/review-and-land.md](references/review-and-land.md).

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - how to write a brief Antigravity
  can execute blind: structure, XML blocks, the report contract, and real gate commands.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - the `delegate` / `follow_up`
  call shapes, the fenced response contract, failure and quota handling, and the `relay.mjs` fallback.
- [references/review-and-land.md](references/review-and-land.md) - the review checklist, the commit
  boundary, and the rework cycle via `follow_up`.
- [references/multi-task-queues.md](references/multi-task-queues.md) - running a sequential queue:
  carrying constraints forward, when `delegate_many` applies, progress tracking, and the end-of-run
  coherence check.
