# claude-agy-mcp

**Claude Code delegates heavy tasks to the Antigravity CLI (`agy`)** — saving Claude's context window and tokens for what matters.

```
User → Claude Code → claude-agy-mcp (MCP) → agy CLI → Gemini / Claude / GPT-OSS
                   ←                      ←         ←
```

## Why this over claude-to-agy?

|                 | claude-to-agy               | **claude-agy-mcp**                                                                   |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Tool surface    | 1 generic `delegate_to_agy` | 6 purpose-built tools — Claude self-routes reliably                                  |
| Model selection | none (agy default only)     | per-tool routing across all `agy models`, with availability detection and fallback   |
| Multi-turn      | stateless                   | session continuity — `follow_up` resumes agy conversations without resending context |
| Output safety   | unbounded                   | configurable truncation cap protects Claude's context                                |
| Sandbox         | no                          | optional `--sandbox` mode                                                            |
| Install         | uvx (Python)                | npx (Node) — zero install                                                            |

## Requirements

- Node.js 18+
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) installed and authenticated
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Install

```bash
# 1. Register the MCP server (user scope = all projects).
#    add-json bakes in a generous client-side timeout so long analyze_files /
#    delegate calls don't trip Claude Code's tool-call deadline (see Timeouts).
claude mcp add-json -s user claude-agy-mcp \
  '{"type":"stdio","command":"npx","args":["-y","@pymodel/claude-agy-mcp"],"timeout":3600000}'

# 2. Add delegation rules to your project (or ~/.claude/CLAUDE.md for global)
curl -o CLAUDE.md https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/CLAUDE.md
```

> The `"timeout": 3600000` (60 min, milliseconds) is the **client-side** tool-call
> deadline, matched to the bridge's default `AGY_MAX_RUNTIME` ceiling. Without it,
> a cold-start `analyze_files` (~40–50s) or a long `delegate` hits Claude Code's
> default and returns `timed out waiting for response` while the agy run is still
> going — and raising the agy-side ceiling alone will not help, because the client
> aborts first. If your client doesn't honor a per-server `timeout`, set the global
> env var `MCP_TOOL_TIMEOUT=3600000` instead.
> Details in [Timeouts and cancellation](#timeouts-and-cancellation).

## Tools

| Tool                 | Use for                                                         | Model routing (first available)                                                                        |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `analyze_files`      | Files >200 lines, >3 files at once, logs, dumps, generated code | Gemini 3.6 Flash (High) → Gemini 3.5 Flash (High) → Gemini 3.1 Pro (Low)                               |
| `deep_search`        | git log/diff/blame archaeology, repo-wide greps                 | Gemini 3.6 Flash (Medium) → Gemini 3.6 Flash (High) → Gemini 3.5 Flash (High)                          |
| `web_lookup`         | Docs, API references, external/current knowledge                | Gemini 3.6 Flash (Medium) → Gemini 3.6 Flash (High) → Gemini 3.5 Flash (High)                          |
| `adversarial_review` | Plan critiques, design and code reviews                         | Gemini 3.1 Pro (High) → Claude Opus 4.6 (Thinking) → Gemini 3.6 Flash (High) → Gemini 3.5 Flash (High) |
| `follow_up`          | Continue a prior session by `session_id` — no context resend    | inherits the session                                                                                   |
| `delegate`           | Anything else heavy                                             | Gemini 3.6 Flash (High) → Gemini 3.5 Flash (High)                                                      |

All tools accept optional `cwd` (project root) and `model` (exact name from `agy models`; validated, with available models listed on mismatch).

Every response ends with a footer:

```
---
[claude-agy-mcp] model: Gemini 3.6 Flash (High) | session: 1f0c…-d4 (use follow_up to continue)
```

### Model routing

On first use the bridge runs `agy models` (cached for the process lifetime) and picks the first available model in the tool's preference chain. If none is available it falls back to `AGY_DEFAULT_MODEL`, and finally to agy's own default. agy silently ignores unknown `--model` values, so the bridge validates names up front instead of letting requests land on the wrong model.

### Quota-aware failover

agy never surfaces quota exhaustion in print mode — it silently retries the 429 until its print-timeout, then exits 0 with empty output, which used to look like an indefinite hang. The bridge now watches each run's log file (via `--log-file`) and on `RESOURCE_EXHAUSTED (code 429)`:

1. kills the agy process group immediately (no waiting out the timeout),
2. parses the reset time ("Resets in 4h24m") into an in-process cooldown registry,
3. retries the same prompt on the next model in the tool's chain,
4. skips cooled-down models on all subsequent calls until their quota resets.

Failovers are annotated in the response footer (`failover: <model>: quota exhausted (resets in 4h24m)`). Only when every candidate is exhausted does the call fail — in seconds, with reset times listed — instead of hanging.

### Timeouts and cancellation

**The bridge does not kill a run for being slow.** Elapsed time cannot distinguish a healthy long model call from a wedged process, and a wrong "stuck" verdict interrupts an agent mid-edit — leaving half-written files behind. So a run is killed only when something authoritative says so:

1. **the caller cancels** (e.g. pressing Esc in Claude Code) — the agy run dies instead of being orphaned,
2. **quota is confirmed exhausted** (a 429 in the run's log), which triggers failover, or
3. **the resource ceiling expires** — `AGY_MAX_RUNTIME`, default 3600s.

The ceiling is a resource cap, not a diagnosis. When it fires, the run still returns everything agy produced so far plus its `session_id`, and says so explicitly: any file changes agy already made are on disk, and `follow_up` resumes from where it stopped. `AGY_TIMEOUT` overrides the ceiling for every tool; `AGY_TIMEOUT_<TOOL_NAME>` overrides it for one (e.g. `AGY_TIMEOUT_DEEP_SEARCH=900`) and wins over the global. The full set is `AGY_TIMEOUT_ANALYZE_FILES`, `AGY_TIMEOUT_DEEP_SEARCH`, `AGY_TIMEOUT_WEB_LOOKUP`, `AGY_TIMEOUT_ADVERSARIAL_REVIEW`, `AGY_TIMEOUT_FOLLOW_UP`, and `AGY_TIMEOUT_DELEGATE`. The kill path escalates SIGTERM → SIGKILL across the whole process group, and fires even if agy's helper processes hold the output pipes open.

**Two timeout layers — and the client one usually bites first.** The ceiling above is the _agy-side_ budget. Your MCP client (Claude Code) has its own, separate _tool-call_ timeout, and if it is shorter, the client gives up first — you'll see `Error: timed out waiting for response`, while the bridge's own ceiling reads `MAXIMUM RUNTIME EXCEEDED` instead. Raising `AGY_MAX_RUNTIME` alone therefore changes nothing: the client still aborts on its own schedule. The work is not lost either way — the agy session persists, so `follow_up` with the returned `session_id` retrieves it — but the real fix is to make the client wait at least as long as the ceiling. The [Install](#install) command sets a per-server `timeout` of 3600000ms (scoped to this server only). If you registered the server without it, re-run the `add-json` command from Install, or set the global env var `MCP_TOOL_TIMEOUT=3600000`. Rule of thumb: **client `timeout` ≥ `AGY_MAX_RUNTIME`**.

**Expected latency.** Most of the perceived "slowness" is cold start: the first call in a session spawns the agy CLI and warms the model. A simple `analyze_files` over 3 files measures around **40–50s cold** (≈46s observed), dropping on subsequent same-session calls. A first call that also hits a quota 429 takes longer while the bridge fails over. So a client timeout below ~60s will intermittently trip on cold starts even for "simple" questions — size it generously.
