<div align="center">

<img src="https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/assets/banner.svg" alt="claude-agy-mcp — Claude Code delegates heavy tasks to the Antigravity CLI" width="100%">

<p>
  <a href="https://www.npmjs.com/package/@pymodel/claude-agy-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@pymodel/claude-agy-mcp?style=flat&logo=npm&logoColor=white&label=downloads&labelColor=1b1f27&color=4E86F5"></a>
  <img alt="visitors" src="https://komarev.com/ghpvc/?username=pymodel-claude-agy-mcp&label=visitors&color=blueviolet&style=flat">
</p>

<p>
  <a href="https://claude.com/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-Orchestrator-e0a83c?style=flat&logo=anthropic&logoColor=white&labelColor=1b1f27"></a>
  <a href="https://gemini.google.com"><img alt="Gemini 3.8 Flash" src="https://img.shields.io/badge/Gemini_3.8_Flash-Implementer-4E86F5?style=flat&logo=googlegemini&logoColor=white&labelColor=1b1f27"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-Protocol-D96570?style=flat&logo=modelcontextprotocol&logoColor=white&labelColor=1b1f27"></a>
</p>

<p>
  <a href="#install"><b>Install</b></a> ·
  <a href="#why-gemini-flash-for-claude-code"><b>Why Gemini 3.8 Flash?</b></a> ·
  <a href="#the-ultimate-ai-engineering-mcp-stack"><b>MCP Power Stack</b></a> ·
  <a href="#tools"><b>Tools</b></a> ·
  <a href="#timeouts-and-cancellation"><b>Timeouts</b></a> ·
  <a href="#configuration"><b>Configuration</b></a>
</p>

# ⚡ Install

```bash
npm i @pymodel/claude-agy-mcp
```

```bash
claude mcp add-json -s user claude-agy-mcp \
  '{"type":"stdio","command":"npx","args":["-y","@pymodel/claude-agy-mcp"],"timeout":3600000}'
```

**Claude Code delegates heavy tasks to Google's flagship Gemini Flash** via the Antigravity CLI (`agy`) — saving Claude's context window and tokens for what matters.

Claude acts as the orchestrator → `claude-agy-mcp` routes compute-heavy sub-tasks to **the newest Gemini Flash agy offers** → only concise answers return. Large files, deep git searches, and log dumps never pollute Claude's context.

</div>

```
User → Claude Code → claude-agy-mcp (MCP) → agy CLI → Gemini 3.8 Flash / Pro / Claude
                   ←                      ←         ← (Clean answers only)
```

## Why Gemini Flash for Claude Code?

<div align="center">
  <img src="https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/assets/benchmarks.svg" alt="Gemini 3.8 Flash Benchmarks" width="100%">
</div>

**Gemini Flash** is Google's most intelligent workhorse model for coding and agentic execution. It applies deep multi-step planning, rigorous terminal reasoning, and high first-pass code accuracy.

> **Gemini 3.8 Flash (High) is the default model for every tool.** Each chain leads with `gemini-flash@latest-high`, which resolves against `agy models` to the newest Flash at High effort — 3.8 Flash as of 2026-09-11 — and only falls back to Pro or Claude when Flash is unavailable or cooling down. The benchmark table below compares 3.8 Flash against 3.7 Flash, from [Google's launch table](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber) (2026-09-02); the bridge does not pin that generation.

### Benchmark Highlights

| Benchmark / Capability    | Gemini 3.8 Flash (High) | Prior Generation (3.7 Flash) | Advantage                                                                      |
| ------------------------- | ----------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| **DeepSWE v1.1**          | **73.7%**               | 65.3%                        | **+8.4 pts** in long-horizon software engineering; within 0.3 of Claude Opus 5 |
| **Terminal-Bench 2.1**    | **89.4%**               | 85.8%                        | **+3.6 pts** in agentic CLI execution; ahead of Opus 5 (89.1%) and GPT-5.6 Sol |
| **OSWorld-2.0**           | **59.0%**               | 50.6%                        | **+8.4 pts** in agentic computer use                                           |
| **HLE-Verified**          | **54.9%**               | 53.6%                        | Multi-step expert reasoning, ahead of Opus 5 (54.4%)                           |
| **Vals Finance Agent v2** | **61.4%**               | 59.0%                        | Leads Opus 5 (58.6%) and GPT-5.6 Sol (53.8%) on quantitative agent work        |
| **Token Economics**       | **$0.75 / $3.75** (1M)  | $0.75 / $3.75                | Same price as 3.7 Flash; up to **10x–20x cheaper** than Claude Opus/Sonnet     |

### The Token & Context Multiplier

When Claude Code directly analyzes a 4,000-line database dump or greps 20 files across git history, those thousands of lines stay permanently in Claude's prompt context, inflating cost and pushing you toward compaction.

With `claude-agy-mcp`:

1. Claude calls `analyze_files` or `deep_search`.
2. Gemini 3.8 Flash processes the 100k+ tokens in isolation via `agy`.
3. Only the exact code-level findings and line citations return into Claude's prompt.
4. Subsequent questions reuse the same agy session with `follow_up` without re-sending any files.

---

## The Ultimate AI Engineering MCP Stack

`claude-agy-mcp` is designed to anchor a modern AI engineer's MCP toolkit alongside complementary specialized servers:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Claude Code (Agent)                             │
└──────┬──────────────────────┬───────────────────────┬───────────────────────┘
       │                      │                       │                       │
       ▼                      ▼                       ▼                       ▼
┌──────────────┐      ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│claude-agy-mcp│      │   context7   │        │  firecrawl   │        │    tavily    │
│  (Gemini 3.8 │      │(Official Docs│        │(Web Scraping │        │(Live Search  │
│  Delegation) │      │  & API Specs)│        │  & Crawling) │        │ & Research)  │
└──────────────┘      └──────────────┘        └──────────────┘        └──────────────┘
```

| MCP Server           | Primary Superpower                    | When Claude Uses It                                                                                                                                            |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`claude-agy-mcp`** | **Heavy Compute & Coding Delegation** | Analyzing files >200 lines, repo archaeology (`git log/diff/blame`), adversarial code reviews, and raw execution via Gemini 3.8 Flash.                         |
| **`context7`**       | **Up-to-date Official Documentation** | Fetching latest version-accurate API signatures and documentation for libraries (Next.js, React, Tailwind, Prisma, Vite, etc.) to eliminate hallucinated APIs. |
| **`firecrawl`**      | **Clean Web Scraping & Crawling**     | Converting dynamic web pages, documentation sites, and GitHub repos into clean, LLM-ready markdown or structured JSON.                                         |
| **`tavily`**         | **Fast Live Search & Grounding**      | Low-latency web search, current news, error message lookups, and technical research.                                                                           |

### Recommended MCP Configuration (`.agents/mcp_config.json` or Claude Code)

```json
{
  "mcpServers": {
    "claude-agy-mcp": {
      "command": "npx",
      "args": ["-y", "@pymodel/claude-agy-mcp"],
      "timeout": 3600000
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"]
    },
    "tavily": {
      "command": "npx",
      "args": ["-y", "tavily-mcp"]
    }
  }
}
```

---

## Why this over claude-to-agy?

|                 | claude-to-agy               | **claude-agy-mcp**                                                                       |
| --------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Tool surface    | 1 generic `delegate_to_agy` | 8 purpose-built tools — Claude self-routes reliably                                      |
| Model selection | none (agy default only)     | per-tool family selectors that follow new generations, with quota failover               |
| Multi-turn      | stateless                   | session continuity — `follow_up` resumes agy conversations without resending context     |
| Output safety   | unbounded                   | configurable truncation cap protects Claude's context                                    |
| Sandbox         | no                          | per-tool privilege: read-only tools pinned to `--mode plan`, optional `--sandbox`        |
| Honest results  | exit code only              | decides on agy's JSON envelope — reports auto-denied tool actions instead of hiding them |
| Install         | uvx (Python)                | npx (Node) — zero install                                                                |

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

# 2. Install the bundled skills into every agent found on this machine.
#    The server gives an agent the tools; the skills tell it when to use them.
npx --package @pymodel/claude-agy-mcp claude-agy-mcp-install-skills
#    --list to preview, --dir <path> to install somewhere explicit,
#    --force to replace a skill you have symlinked to your own checkout.

# 3. Optional: add delegation rules to your project (or ~/.claude/CLAUDE.md).
curl -o CLAUDE.md https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/CLAUDE.md
```

### Bundled skills

Installing the package installs the skills too, so there is nothing separate to vendor
or keep in sync:

| Skill            | What it does                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy-delegation` | Routing rules: which tool to reach for, and when delegating beats doing the work in-context.                                                                                                                                       |
| `agy-delegate`   | The full delegate-and-review workflow — writing a brief agy can execute blind, dispatching it, reviewing the diff against the brief, and landing it yourself. Includes a CLI-relay fallback for agents that cannot call MCP tools. |

> The `"timeout": 3600000` (60 min, milliseconds) is the **client-side** tool-call
> deadline, matched to the bridge's default `AGY_MAX_RUNTIME` ceiling. Without it,
> a cold-start `analyze_files` (~40–50s) or a long `delegate` hits Claude Code's
> default and returns `timed out waiting for response` while the agy run is still
> going — and raising the agy-side ceiling alone will not help, because the client
> aborts first. If your client doesn't honor a per-server `timeout`, set the global
> env var `MCP_TOOL_TIMEOUT=3600000` instead.
> Details in [Timeouts and cancellation](#timeouts-and-cancellation).

## Tools

| Tool                 | Use for                                                                                     | Model routing (first available)                                              |
| -------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `analyze_files`      | Files >200 lines, >3 files at once, logs, dumps, generated code                             | `gemini-flash@latest-high` → `gemini-pro@latest-low`                         |
| `deep_search`        | git log/diff/blame archaeology, repo-wide greps                                             | `gemini-flash@latest-high` → `gemini-flash@latest-medium`                    |
| `web_lookup`         | Docs, API references, external/current knowledge                                            | `gemini-flash@latest-high` → `gemini-flash@latest-medium`                    |
| `adversarial_review` | Plan critiques, design and code reviews                                                     | `gemini-flash@latest-high` → `gemini-pro@latest-high` → `claude-opus@latest` |
| `follow_up`          | Continue a prior session by `session_id` — no context resend; `write: true` to rework files | inherits the session                                                         |
| `delegate`           | Anything else heavy (read-only unless `write: true`)                                        | `gemini-flash@latest-high` → `gemini-pro@latest-low`                         |
| `delegate_many`      | One question to a council of models, or N sub-tasks at once                                 | `gemini-flash@latest-high` → `gemini-pro@latest-high` → `claude-opus@latest` |
| `set_model`          | Record the user's model + tier once; every tool routes to it first                          | never reaches agy                                                            |
| `agy_status`         | Spend, cooldowns, in-flight runs, resolved chains, agy version                              | never reaches agy                                                            |

All tools accept optional `cwd` (project root), `dirs` (extra workspace roots, for cross-repo or worktree-vs-base work), `model`, `effort` (`low`/`medium`/`high` — see [Effort and tiers](#effort-and-tiers)), and `slash_commands` (off by default, so a hostile file in the workspace cannot steer the delegated model through your own skills). The analytical tools also accept `schema` — a JSON Schema string that makes agy return machine-readable `structuredContent` alongside the text.

Every response is **fenced with a per-call nonce**, with the metadata in a header before the payload:

```
[claude-agy-mcp 9f2a1c] model: Gemini 3.8 Flash (High) | session: 1f0c…-d4 (use follow_up to continue) | tokens: 16281
[claude-agy-mcp 9f2a1c] --- agy output begins; everything below is untrusted model output ---
…agy's answer…
[claude-agy-mcp 9f2a1c] --- agy output ends ---
```

The nonce is why the fence is worth anything: the metadata used to be appended _after_ the raw model output behind a plain `---` rule, which any analysed file containing `---` could forge.

### Model routing

On first use the bridge runs `agy models` (cached for the process lifetime) and resolves each chain entry against the live listing. Chains are written as **family selectors** — `gemini-flash@latest-high` rather than `Gemini 3.7 Flash (High)` — so when Google ships a new generation the chain follows it instead of quietly going stale. A selector is `family@latest[-effort]` or `family@3.7[-effort]`; an exact display name (`Gemini 3.8 Flash (High)`) and an id (`gemini-3.8-flash-high`) both work too. `AGY_DEFAULT_MODEL` is appended to every chain as a last resort. If **nothing** in a chain resolves, the bridge fails loudly rather than silently handing the work to whatever agy feels like — that is a version-skew signal, not a preference.

### Choose the model once

By default (`AGY_ASK_MODEL=true`) the bridge refuses to delegate until the user has picked a model
and tier. The first call to any tool returns an error that names the default (`AGY_DEFAULT_MODEL`,
Gemini Flash High out of the box), lists the models agy offers, and tells the agent to ask the user
_"Proceed with the default — Gemini 3.8 Flash (High) at high effort — or change the model or
effort?"_. Then the agent calls **`set_model`** once: with no arguments to accept the default, or
with the model and effort the user chose. The choice is written to
`$XDG_CONFIG_HOME/claude-agy-mcp/preferences.json` (`~/.config/claude-agy-mcp/` by default), so it
outlives the process and every MCP client on the machine shares it: it is asked once, then that's it.
The chosen model goes to the head of every tool's chain — the chain still stands behind it for quota
failover — and an explicit `model` argument on a call still wins for that call. `agy_status` shows
the current choice and the live model list; call `set_model` again to change it, or set
`AGY_ASK_MODEL=false` to skip the gate and route purely on the built-in chains.

<p align="center">
  <img src="https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/assets/set-model-prompt.png" alt="Claude Code showing the claude-agy-mcp model form: Proceed with the default — Gemini 3.8 Flash (High) at high effort — or change? with Model and Effort pickers and Accept / Decline" width="720">
  <br>
  <sub>The form as Claude Code renders it on first use — the server asks, not the agent.</sub>
</p>

### Effort and tiers

agy 1.2.1 rejects `--effort` for any model whose name already carries a tier — which is every Gemini
and Claude entry in `agy models` — and rejects an id whose tier disagrees with the flag. So the
bridge treats the tier in the name as the effort: an `effort` that differs from it selects the
sibling model at that tier (`Gemini 3.8 Flash (High)` + `effort: medium` → `Gemini 3.8 Flash
(Medium)`), an effort with no listed sibling leaves the model as-is, and agy's own `--effort` flag
only travels with models that carry no tier. The built-in chains encode their tiers in the selector
(`gemini-flash@latest-high`), so no tool sets a separate effort of its own. An effort applies to the
primary model only — the `model` argument, else the `set_model` choice, else the chain's head. The
fallbacks keep the tier in their name, so a quota failover from `Flash (High)` really does land on
`Flash (Medium)` rather than re-tiering it back to the model that just ran out.

### Quota-aware failover

agy never surfaces quota exhaustion in print mode — it silently retries the 429 until its print-timeout, then exits 0 with empty output, which used to look like an indefinite hang. The bridge now watches each run's log file (via `--log-file`) and on `RESOURCE_EXHAUSTED (code 429)`:

1. kills the agy process group immediately (no waiting out the timeout),
2. parses the reset time ("Resets in 4h24m") into an in-process cooldown registry,
3. retries the same prompt on the next model in the tool's chain,
4. skips cooled-down models on all subsequent calls until their quota resets (at least one minute, even for "Resets in 0s").

A model you pin with `model` is tried even while it is cooling down. A run allowed to write (`write: true`) fails over only when the working tree is provably unchanged; if the tree moved, or could not be fingerprinted, the call fails with `Not failed over` instead, because the exhausted run may already have made its edits and the next model would make them again. The same rule governs the single retry after a network error, and a resident session that returned an empty answer.

Failovers are annotated in the response footer (`failover: <model>: quota exhausted (resets in 4h24m)`). Only when every candidate is exhausted does the call fail — in seconds, with reset times listed — instead of hanging.

### Timeouts and cancellation

**The bridge does not kill a run for being slow.** Elapsed time cannot distinguish a healthy long model call from a wedged process, and a wrong "stuck" verdict interrupts an agent mid-edit — leaving half-written files behind. So a run is killed only when something authoritative says so:

1. **the caller cancels** (e.g. pressing Esc in Claude Code), **the client disconnects**, or **the bridge is stopped** — every agy run it started dies with it instead of being orphaned,
2. **quota is confirmed exhausted** (a 429 in the run's log), which triggers failover, or
3. **the resource ceiling expires** — `AGY_MAX_RUNTIME`, default 3600s.

The ceiling is a resource cap, not a diagnosis. When it fires, the run still returns everything agy produced so far plus its `session_id`, and says so explicitly: any file changes agy already made are on disk, and `follow_up` resumes from where it stopped. `AGY_TIMEOUT` overrides the ceiling for every tool; `AGY_TIMEOUT_<TOOL_NAME>` overrides it for one (e.g. `AGY_TIMEOUT_DEEP_SEARCH=900`) and wins over the global. The full set is `AGY_TIMEOUT_ANALYZE_FILES`, `AGY_TIMEOUT_DEEP_SEARCH`, `AGY_TIMEOUT_WEB_LOOKUP`, `AGY_TIMEOUT_ADVERSARIAL_REVIEW`, `AGY_TIMEOUT_FOLLOW_UP`, `AGY_TIMEOUT_DELEGATE` and `AGY_TIMEOUT_DELEGATE_MANY`; any other `AGY_TIMEOUT_<NAME>` is a startup error, so a misspelt limit cannot silently not apply. Every timeout is at most 604800s (7 days), because Node fires a longer timer immediately. The kill path escalates SIGTERM → SIGKILL across the whole process group, and fires even if agy's helper processes hold the output pipes open.

**Two timeout layers — and the client one usually bites first.** The ceiling above is the _agy-side_ budget. Your MCP client (Claude Code) has its own, separate _tool-call_ timeout, and if it is shorter, the client gives up first — you'll see `Error: timed out waiting for response`, while the bridge's own ceiling reads `MAXIMUM RUNTIME EXCEEDED` instead. Raising `AGY_MAX_RUNTIME` alone therefore changes nothing: the client still aborts on its own schedule. The work is not lost either way — the agy session persists, so `follow_up` with the returned `session_id` retrieves it — but the real fix is to make the client wait at least as long as the ceiling. The [Install](#install) command sets a per-server `timeout` of 3600000ms (scoped to this server only). If you registered the server without it, re-run the `add-json` command from Install, or set the global env var `MCP_TOOL_TIMEOUT=3600000`. Rule of thumb: **client `timeout` ≥ `AGY_MAX_RUNTIME`**.

**Expected latency.** Most of the perceived "slowness" is cold start: each call spawns the agy CLI and warms the model. Measured on agy 1.2.0, a trivial prompt costs **2–6s**, a run whose tool actions get denied around **16s**, and one constrained by `--json-schema` up to **56s** (the schema roughly triples thinking tokens). Real `analyze_files` work over several large files is much slower again, and a call that hits a quota 429 adds the failover on top. `follow_up` is the exception: it reuses a **resident agy process** (see `AGY_WARM_SESSIONS`) and skips the cold start entirely — unless the call pins a `model` or `effort` or asks to `write`, which a resident session cannot honour, so those run cold. A resident turn is bounded by the same runtime ceiling and cancellation as a cold run. Size the client timeout for the slow cases, not the fast ones.

## Configuration

All optional, via environment variables:

| Variable                   | Default                    | Description                                                                                                                                                                   |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGY_PATH`                 | `agy`                      | Path to the agy binary                                                                                                                                                        |
| `AGY_MAX_RUNTIME`          | `3600`                     | Seconds; absolute runtime ceiling. The bridge never kills for inactivity — only cancellation, quota, or this                                                                  |
| `AGY_TIMEOUT`              | `AGY_MAX_RUNTIME`          | Seconds; overrides the ceiling for every tool, passed as `--print-timeout`, enforced with a 15s kill grace                                                                    |
| `AGY_TIMEOUT_<TOOL>`       | `AGY_MAX_RUNTIME`          | Seconds; overrides the ceiling for a single tool, e.g. `AGY_TIMEOUT_DEEP_SEARCH=900`. Wins over `AGY_TIMEOUT`                                                                 |
| `AGY_MAX_OUTPUT_CHARS`     | `50000`                    | Truncation cap for tool output                                                                                                                                                |
| `AGY_DEFAULT_MODEL`        | `gemini-flash@latest-high` | Appended to every chain as a last resort                                                                                                                                      |
| `AGY_ASK_MODEL`            | `true`                     | Refuse to delegate until the user has chosen a model via `set_model` (asked once, saved per machine)                                                                          |
| `AGY_EFFORT`               | agy's own default          | `low` \| `medium` \| `high` fallback tier; selects the sibling model at that tier (see Effort and tiers)                                                                      |
| `AGY_SKIP_PERMISSIONS`     | `true`                     | Pass `--dangerously-skip-permissions` to agy                                                                                                                                  |
| _(all boolean vars)_       | —                          | Accept `true/false`, `1/0`, `yes/no`, `on/off`, case-insensitive. An unrecognized value is a startup error, never a silent default                                            |
| _(all numeric vars)_       | —                          | Plain decimal digits only (`1e3`, `0x10` and padded values are startup errors). Enum vars (`AGY_EFFORT`, `AGY_ON_FAILURE`) are case-insensitive                               |
| `AGY_SANDBOX`              | `false`                    | Run agy with `--sandbox`                                                                                                                                                      |
| `AGY_ON_FAILURE`           | `fallback`                 | `strict` appends an instruction to failed-tool errors telling the calling agent not to absorb the work itself                                                                 |
| `AGY_MAX_CONCURRENCY`      | `2`                        | Most agy processes at once. Calls beyond it queue instead of stampeding the shared quota                                                                                      |
| `AGY_BUDGET_TOKENS`        | unset                      | Hard stop once this many tokens have been spent since startup. Check spend with `agy_status`                                                                                  |
| `AGY_ALLOWED_ROOTS`        | unset (unrestricted)       | Roots that `cwd`, `dirs`, `files` and derived workspace roots may not escape, symlinks followed; separated by `:` (`;` on Windows) or commas. Input validation, not a sandbox |
| `AGY_REDACT`               | `true`                     | Scrub credential-shaped strings out of returned text before it reaches the caller's context                                                                                   |
| `AGY_MAX_DELEGATION_DEPTH` | `1`                        | Refuse to delegate once this deep, so Claude → agy → this server → agy cannot loop                                                                                            |
| `AGY_WARM_SESSIONS`        | `true`                     | Keep a resident agy process per conversation so `follow_up` skips the cold start                                                                                              |
| `AGY_WARM_MAX`             | `2`                        | Most resident sessions to keep; the least recently used is evicted                                                                                                            |
| `AGY_WARM_IDLE_SEC`        | `300`                      | Kill a resident session after this long idle                                                                                                                                  |

> [!WARNING]
> **`AGY_SKIP_PERMISSIONS` is a real grant, and agy does not enforce read-only on top of it.** It
> defaults to `true` because headless agy auto-denies _every_ permissioned tool without it — including
> `read_file` — and a single denial ends the run with an empty response, so a bridge without the grant
> cannot read, search or fetch anything. The read-only tools pass `--mode plan`, but **verified
> against agy 1.2.1 and again against 1.2.2: plan mode is advisory once permissions are skipped.** agy
> creates files in a `--mode plan --dangerously-skip-permissions` run. Treat every run as having the
> access of the user running the bridge.
>
> Because it cannot be prevented, it is **detected**: the bridge fingerprints the working tree around
> every plan-mode run and adds a `READ-ONLY VIOLATION` warning to the response header when the tree
> changed. No warning means it looked and found nothing; a tree it could not fingerprint produces no
> claim in either direction. The fingerprint covers `cwd` and every directory the call hands agy. In
> a git repository it covers HEAD, the content and mode of every tracked change, and the content of
> every untracked file — but not files git ignores, so a write to a build output or `.env` is not
> seen. Outside git it compares path, type, size, mode and mtime, bounded to 20,000 entries and 10s.
> Anything else writing to the tree while the run is live (an editor, a watcher, a parallel write
> delegation) also moves it: the warning means the tree changed during the run, not proof of who
> changed it. A plan run that wrote and then failed carries the warning in its error. That warning, not the tool's name and not the absence of a
> **denied-actions** note, is the signal to trust — denied actions only ever populate when the grant
> is off.
>
> A restriction that cannot be enforced fails the call: if the installed agy does not support
> `--mode` or `--sandbox`, a run needing either is refused rather than run with more authority than
> was asked for. `--sandbox` is in any case a terminal restriction, not a permission boundary.

> [!IMPORTANT]
> **`AGY_ALLOWED_ROOTS` validates inputs; it is not a sandbox.** It checks every call's `cwd`, `dirs`
> and `files` — including the workspace roots the bridge derives from them — before agy starts, so a
> caller cannot point a delegation outside the roots you nominate. It does **not** confine the run:
> under the permission grant agy has a shell and can reach anything the user running the bridge can.
> For real containment, run the bridge somewhere contained.

### Failure behavior

The bridge always fails loudly, and it decides what "failure" means from agy's JSON envelope rather than from its exit code. That matters because agy can exit 0 with `status: SUCCESS` and a plausible answer while having silently had its tool actions auto-denied — the bridge surfaces those as a denied-actions warning instead of passing off a half-worked answer as a clean one. Failures are classified: only a quota 429 fails over to the next model, a network error is retried once, and an invalid model or an expired login stops immediately instead of burning the whole chain. A status code counts only beside a status word, so `read 429 bytes` in a log is not a quota error and `foo.ts:401` is not an auth failure. Tokens a failed attempt spent still count against `AGY_BUDGET_TOKENS`. Degraded model routing is annotated in the response header. By default the calling agent (Claude) will typically do the work itself after a failure — visible in the transcript, but easy to stop noticing in a long session. Set `AGY_ON_FAILURE=strict` to append an explicit "do NOT perform this work yourself — report the failure to the user" instruction to every delegation error, so you keep control over when token savings are silently lost. A call rejected before anything was delegated — a path outside the roots, a missing `cwd`, a prompt agy cannot receive — is the caller's to fix and carries no such instruction.

## Known limitations

Deliberately not addressed, so they are not mistaken for oversights:

- **The delegation-depth counter is cooperative.** `AGY_MAX_DELEGATION_DEPTH` is
  propagated to the child through an environment variable, so a nested launcher that
  scrubs the environment resets it to zero. The failure mode is wasted quota through a
  delegation loop, not a privilege escape.
- **The run log is not redacted.** `AGY_REDACT` scrubs what returns to the caller; the
  temporary log agy writes for the quota poller can hold secrets in cleartext until the
  run ends. It lives in a per-process directory only your user can read, is removed on
  shutdown, and one left behind by a crash is removed the next time the bridge starts.
- **Inputs are bounded.** A prompt is passed to agy as one command-line argument, so a
  built prompt over 128 KiB (Linux's per-argument limit), or one containing a NUL byte,
  is refused before anything runs; pass file paths rather than inlining large content.
  `delegate_many` takes at most 8 tasks or 8 distinct models, and `tasks` cannot be
  combined with `models`.
- **`--disable-slash-commands` is best-effort.** Unlike `--mode plan` and `--sandbox`,
  it is dropped rather than refused when the installed agy does not advertise it, on
  the reasoning that a build without the flag most likely has no expansion to disable.
- **A fan-out sharing one `session_id` runs sequentially.** agy holds a
  per-conversation lock, so concurrent turns against one conversation would corrupt it.
  Fan out across conversations for parallelism.

## Development

```bash
npm install
npm test           # vitest unit tests (exec mocked — no agy needed)
npm run typecheck
npm run build      # tsup → dist/index.js
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) — conventional commits, prettier, and a test per behaviour change. Vulnerabilities go through [SECURITY.md](SECURITY.md), never a public issue.

## Contributors

<a href="https://github.com/PyModel/claude-agy-mcp/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=PyModel/claude-agy-mcp" alt="Contributors" />
</a>

## License

MIT
