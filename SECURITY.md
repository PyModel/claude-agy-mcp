# Security Policy

## Supported versions

Only the latest published `@pymodel/claude-agy-mcp` release receives fixes.

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/PyModel/claude-agy-mcp/security/advisories/new). Do not open a public issue.

Expect an acknowledgement within 7 days and a fix or mitigation plan within 30.

## Threat notes

This server spawns the local `agy` CLI as a subprocess with the caller's credentials and filesystem access. Prompts sent through it are forwarded to whichever model `agy` is authenticated against.

The trust chain runs **file contents → agy's model → verbatim into the calling agent's context window**, so both ends are gated rather than merely documented:

- **Path allowlist.** Set `AGY_ALLOWED_ROOTS` to a colon- or comma-separated list of absolute roots. `cwd`, `dirs` and every `files` entry are resolved and checked against it _before_ agy is spawned, so an absolute path cannot reach `~/.aws/credentials` or another client's repo. Unset means unrestricted, which is the historical behaviour.
- **Output redaction.** `AGY_REDACT` (default `true`) scrubs credential-shaped strings — API keys, tokens, JWTs, private-key blocks, and the values of `*_SECRET` / `*_TOKEN` / `*_PASSWORD` assignments — out of returned text. It is deliberately shape-based, not entropy-based: a 40-character hex string is far more often a git SHA in a code review than a secret.
- **Least privilege per tool.** The five read-only tools run `--mode plan`; only `delegate` can be granted write access, and only when the caller passes `write: true`. Anything agy was refused comes back as a denied-actions note.
- **Slash-command expansion off by default.** Without `--disable-slash-commands`, a hostile `AGENTS.md`, skill, or filename in the workspace can steer the delegated model through the user's own commands. Pass `slash_commands: true` to opt back in.
- **Response fencing.** Server metadata is wrapped in a per-call nonce and placed before the payload, so analysed content cannot forge a footer or append instructions the caller will obey.
- **Recursion guard.** `AGY_MAX_DELEGATION_DEPTH` (default `1`) stops a Claude → agy → claude-agy-mcp → agy loop if the server is also registered inside agy.

Redaction and allowlisting reduce exposure; they are not a guarantee. Do not pass secrets in tool arguments, and prefer `sandbox: true` for untrusted work.
