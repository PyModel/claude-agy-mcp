---
name: agy-delegation
description: Use when analyzing large files (>200 lines), more than 3 files at once, deep git/grep searches, web lookups, or adversarial reviews - delegates to the Antigravity CLI via claude-agy-mcp MCP tools to save context.
---

# Delegating to Antigravity CLI

Use the claude-agy-mcp MCP tools instead of doing heavy work yourself:

| Situation                                    | Tool                                      |
| -------------------------------------------- | ----------------------------------------- |
| File >200 lines, logs, dumps, generated code | `analyze_files`                           |
| >3 files in one task                         | `analyze_files`                           |
| Git history / repo-wide search               | `deep_search`                             |
| Docs or external knowledge                   | `web_lookup`                              |
| Plan critique, code review                   | `adversarial_review`                      |
| Follow-up on a prior delegation              | `follow_up` (use the returned session id) |
| Anything else heavy                          | `delegate`                                |
