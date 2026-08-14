# Multi-client support plan

> Status: planned, not started. Captured 2026-06-12.

Extend claude-agy-mcp beyond Claude Code to other MCP-capable coding agents:
**Codex CLI, Cursor, Windsurf, VS Code Copilot (agent mode)**.

## Key insight: zero server changes

claude-agy-mcp speaks standard MCP over stdio — the protocol is client-agnostic,
and any MCP client can run `npx -y @pymodel/claude-agy-mcp` today. The only "Claude"
reference in `src/` is a backend model name in the `adversarial_review`
routing chain (`src/tools.ts`), not a client assumption.

The actual work is documentation and instructions-file packaging.

## Out of scope: Gemini CLI

Deliberately excluded. Gemini CLI and Antigravity CLI are both Google agentic
CLIs backed by the same Gemini models (and typically the same account/quota).
Delegating from Gemini CLI through claude-agy-mcp routes Gemini work to Gemini
through an extra hop:

- No second model family for `adversarial_review` (agy _can_ route reviews to
  Claude Opus, but a Gemini CLI user has that in agy directly).
- Context offloading is a weak argument when the user could run agy as their
  primary CLI instead.

Excluding it also simplifies packaging: all four target clients read
`AGENTS.md` natively, so no `GEMINI.md` or `settings.json` context override
to document.

Positioning: **"claude-agy-mcp brings Gemini delegation to non-Gemini agents."**
