<div align="center">

<img src="https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/assets/banner.svg" alt="claude-agy-mcp — Claude Code delegates heavy tasks to the Antigravity CLI" width="100%">

<p>
  <a href="https://github.com/PyModel/claude-agy-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/PyModel/claude-agy-mcp/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI&labelColor=1b1f27&color=e0a83c"></a>
  <a href="https://www.npmjs.com/package/@pymodel/claude-agy-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/@pymodel/claude-agy-mcp?style=for-the-badge&logo=npm&logoColor=white&label=npm&labelColor=1b1f27&color=e0a83c"></a>
  <a href="https://www.npmjs.com/package/@pymodel/claude-agy-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@pymodel/claude-agy-mcp?style=for-the-badge&logo=npm&logoColor=white&label=downloads&labelColor=1b1f27&color=e0a83c"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/@pymodel/claude-agy-mcp?style=for-the-badge&logo=nodedotjs&logoColor=white&label=node&labelColor=1b1f27&color=e0a83c"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@pymodel/claude-agy-mcp?style=for-the-badge&logo=opensourceinitiative&logoColor=white&label=license&labelColor=1b1f27&color=e0a83c"></a>
</p>

<p>
  <a href="#install"><b>Install</b></a> ·
  <a href="#why-gemini-37-flash-high-for-claude-code"><b>Why Gemini 3.7 Flash?</b></a> ·
  <a href="#the-ultimate-ai-engineering-mcp-stack"><b>MCP Power Stack</b></a> ·
  <a href="#tools"><b>Tools</b></a> ·
  <a href="#timeouts-and-cancellation"><b>Timeouts</b></a> ·
  <a href="#configuration"><b>Configuration</b></a>
</p>

**Claude Code delegates heavy tasks to Google's flagship Gemini 3.7 Flash (High)** via the Antigravity CLI (`agy`) — saving Claude's context window and tokens for what matters.

Claude acts as the orchestrator → `claude-agy-mcp` routes compute-heavy sub-tasks to **Gemini 3.7 Flash (High)** → only concise answers return. Large files, deep git searches, and log dumps never pollute Claude's context.

</div>

```
User → Claude Code → claude-agy-mcp (MCP) → agy CLI → Gemini 3.7 Flash / Pro / Claude
                   ←                      ←         ← (Clean answers only)
```

## Why Gemini 3.7 Flash (High) for Claude Code?

<div align="center">
  <img src="https://raw.githubusercontent.com/PyModel/claude-agy-mcp/main/assets/benchmarks.svg" alt="Gemini 3.7 Flash Benchmarks" width="100%">
</div>

**Gemini 3.7 Flash** is Google's most intelligent workhorse model for coding and agentic execution. It applies deep multi-step planning, rigorous terminal reasoning, and high first-pass code accuracy.

### Benchmark Highlights

| Benchmark / Capability | Gemini 3.7 Flash (High) | Prior Generation (3.6 Flash) | Advantage                                                                                 |
| ---------------------- | ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| **DeepSWE v1.1**       | **65.3%**               | 49.0%                        | **+16.3%** jump in long-horizon repository software engineering                           |
| **FrontierCode 1.1**   | **43.6%**               | 34.4%                        | **+9.2%** improvement in production code quality and first-pass accuracy                  |
| **Terminal-Bench 2.1** | **85.8%**               | 78.0%                        | **+7.8%** higher resilience in agentic CLI execution & tool chaining                      |
| **WebDev Arena**       | **1588 Elo**            | 1538 Elo                     | **#1 Rank** for fullstack web application and UI design adherence                         |
| **AutomationBench**    | **30.4%**               | 17.0%                        | Surpasses GPT-5.6 Terra (23.6%) and Claude Sonnet 5 (10.7%) in enterprise agent workflows |
| **Context & Window**   | **1,000,000 Tokens**    | 1,000,000 Tokens             | 64K output tokens with 97.0% retrieval on GDM-MRCR v2 (128k)                              |
| **Token Economics**    | **$0.75 / $3.75** (1M)  | $1.50 / $7.50                | Up to **10x–20x cheaper** than Claude Opus/Sonnet for background delegation               |

### The Token & Context Multiplier

When Claude Code directly analyzes a 4,000-line database dump or greps 20 files across git history, those thousands of lines stay permanently in Claude's prompt context, inflating cost and pushing you toward compaction.

With `claude-agy-mcp`:

1. Claude calls `analyze_files` or `deep_search`.
2. Gemini 3.7 Flash processes the 100k+ tokens in isolation via `agy`.
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
│  (Gemini 3.7 │      │(Official Docs│        │(Web Scraping │        │(Live Search  │
│  Delegation) │      │  & API Specs)│        │  & Crawling) │        │ & Research)  │
└──────────────┘      └──────────────┘        └──────────────┘        └──────────────┘
```

| MCP Server           | Primary Superpower                    | When Claude Uses It                                                                                                                                            |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`claude-agy-mcp`** | **Heavy Compute & Coding Delegation** | Analyzing files >200 lines, repo archaeology (`git log/diff/blame`), adversarial code reviews, and raw execution via Gemini 3.7 Flash.                         |
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

|                 | claude-to-agy               | **claude-agy-mcp**                                                                   |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Tool surface    | 1 generic `delegate_to_agy` | 6 purpose-built tools — Claude self-routes reliably                                  |
| Model selection | none (agy default only)     | per-tool routing prioritizing **Gemini 3.7 Flash (High)** with quota failover        |
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
| `analyze_files`      | Files >200 lines, >3 files at once, logs, dumps, generated code | Gemini 3.7 Flash (High) → Gemini 3.5 Flash (High) → Gemini 3.1 Pro (Low)                               |
| `deep_search`        | git log/diff/blame archaeology, repo-wide greps                 | Gemini 3.7 Flash (Medium) → Gemini 3.7 Flash (High) → Gemini 3.5 Flash (High)                          |
| `web_lookup`         | Docs, API references, external/current knowledge                | Gemini 3.7 Flash (Medium) → Gemini 3.7 Flash (High) → Gemini 3.5 Flash (High)                          |
| `adversarial_review` | Plan critiques, design and code reviews                         | Gemini 3.1 Pro (High) → Claude Opus 4.6 (Thinking) → Gemini 3.7 Flash (High) → Gemini 3.5 Flash (High) |
| `follow_up`          | Continue a prior session by `session_id` — no context resend    | inherits the session                                                                                   |
| `delegate`           | Anything else heavy                                             | Gemini 3.7 Flash (High) → Gemini 3.5 Flash (High)                                                      |

All tools accept optional `cwd` (project root) and `model` (exact name from `agy models`; validated, with available models listed on mismatch).

Every response ends with a footer:

```
---
[claude-agy-mcp] model: Gemini 3.7 Flash (High) | session: 1f0c…-d4 (use follow_up to continue)
```

### Model routing

On first use the bridge runs `agy models` (cached for the process lifetime) and picks the first available model in the tool's preference chain (defaulting to **Gemini 3.7 Flash (High)**). If none is available it falls back to `AGY_DEFAULT_MODEL`, and finally to agy's own default. agy silently ignores unknown `--model` values, so the bridge validates names up front instead of letting requests land on the wrong model.

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

## Configuration

All optional, via environment variables:

| Variable               | Default                 | Description                                                                                                   |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `AGY_PATH`             | `agy`                   | Path to the agy binary                                                                                        |
| `AGY_MAX_RUNTIME`      | `3600`                  | Seconds; absolute runtime ceiling. The bridge never kills for inactivity — only cancellation, quota, or this  |
| `AGY_TIMEOUT`          | `AGY_MAX_RUNTIME`       | Seconds; overrides the ceiling for every tool, passed as `--print-timeout`, enforced with a 15s kill grace    |
| `AGY_TIMEOUT_<TOOL>`   | `AGY_MAX_RUNTIME`       | Seconds; overrides the ceiling for a single tool, e.g. `AGY_TIMEOUT_DEEP_SEARCH=900`. Wins over `AGY_TIMEOUT` |
| `AGY_MAX_OUTPUT_CHARS` | `50000`                 | Truncation cap for tool output                                                                                |
| `AGY_DEFAULT_MODEL`    | Gemini 3.7 Flash (High) | Fallback model when no chain entry is available                                                               |
| `AGY_SKIP_PERMISSIONS` | `true`                  | Pass `--dangerously-skip-permissions` to agy                                                                  |
| `AGY_SANDBOX`          | `false`                 | Run agy with `--sandbox`                                                                                      |
| `AGY_ON_FAILURE`       | `fallback`              | `strict` appends an instruction to failed-tool errors telling the calling agent not to absorb the work itself |

> [!WARNING]
> **The defaults trade sandboxing for reliability.** `AGY_SKIP_PERMISSIONS` defaults to `true` and
> `AGY_SANDBOX` to `false`, so every delegated task runs `agy` with `--dangerously-skip-permissions`
> and no sandbox — the delegated model gets unapproved read, write and execute access inside the
> `cwd` you pass it. That is what stops agy from blocking forever on an interactive approval prompt
> in a non-interactive MCP context, but it is a real grant. Set `AGY_SKIP_PERMISSIONS=false` (expect
> prompts) or `AGY_SANDBOX=true` if you are delegating into a directory you do not fully trust.

### Failure behavior

The bridge always fails loudly: agy errors surface as MCP tool errors with agy's actual stderr, and degraded model routing is annotated in the response footer. By default the calling agent (Claude) will typically do the work itself after a failure — visible in the transcript, but easy to stop noticing in a long session. Set `AGY_ON_FAILURE=strict` to append an explicit "do NOT perform this work yourself — report the failure to the user" instruction to every delegation error, so you keep control over when token savings are silently lost.

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
