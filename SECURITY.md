# Security Policy

## Supported versions

Only the latest published `@pymodel/claude-agy-mcp` release receives fixes.

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/PyModel/claude-agy-mcp/security/advisories/new). Do not open a public issue.

Expect an acknowledgement within 7 days and a fix or mitigation plan within 30.

## Threat notes

This server spawns the local `agy` CLI as a subprocess with the caller's credentials and filesystem access. Prompts sent through it are forwarded to whichever model `agy` is authenticated against. Do not pass secrets in tool arguments, and prefer the optional `--sandbox` mode for untrusted work.
