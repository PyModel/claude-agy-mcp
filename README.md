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
