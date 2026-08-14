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
