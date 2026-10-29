# AGENTS.md

## Purpose and status

Workshop starter for a GitHub issue triage bot on Cloudflare. The target app is a
separate order-tracker demo repo (an attendee's public fork).

Current state, **checkpoint 0**: a Worker that verifies GitHub webhook signatures
and logs each delivery as `webhook.received`. There is no agent, model, sandbox,
Workflow, storage, or GitHub API access yet. Do not claim those exist.

The workshop builds, in order: a reproduction agent in a sandbox (checkpoint 1),
a structured outcome, issue → Workflow → comment orchestration, and trusted
verification of the agent's claim.

## Stack

Flue 2.3 on the Cloudflare target (Vite build; `'use agent'` modules become
Durable Objects), Hono, TypeScript, pnpm, Vitest (Node), Biome, wrangler 4.
`@cloudflare/sandbox` is pinned to 0.12.14 for later checkpoints; Flue's
`cloudflareSandbox()` expects the 0.x API, so do not upgrade it to 1.x.

## Commands

`pnpm dev`, `pnpm run deploy` (not `pnpm deploy`), `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm cf-typegen`, `pnpm webhook:send`. After any change
run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and report results
honestly.

## Conventions

- `src/app.ts` is the only HTTP surface. Worker-level exports (Durable Object,
  Workflow, and container classes) go in `src/cloudflare.ts` when they are added.
- Each new binding goes in `wrangler.jsonc`, followed by `pnpm cf-typegen`. Adding
  an agent or Durable Object class requires a new append-only migration entry.
- Keep the webhook adapter thin. Signature verification happens inside the Flue
  GitHub channel before the handler runs.
- Log with one JSON object per line: `{"event": "<name>", ...fields}`.
- Two-space indent, 100 columns (Biome). No code comments unless requested.

## Safety rules

- Never parse or act on a webhook before its signature is verified.
- Issue titles and bodies are untrusted. Never put them into shell commands,
  paths, URLs, or configuration.
- Secrets live in `wrangler secret` (deployed) or `.dev.vars` (local, gitignored).
  Never commit, log, or print them.
- Do not commit, push, deploy, or create GitHub issues unless asked.
