# AGENTS.md

## Purpose

Workshop project: a GitHub issue triage bot on Cloudflare. The target app is a
separate order-tracker demo repo (an attendee's public fork). The workshop builds
the bot in checkpoints; `README.md` lists them and what each adds.

This file is the same on every checkpoint branch. To know what exists right now,
read `wrangler.jsonc` (bindings), `src/app.ts` (wiring), and `src/agents/`. Never
claim a feature exists because a later checkpoint or this file mentions it.

## Stack

Flue **2.0.0, pinned exactly** on the Cloudflare target (Vite build; `'use agent'`
modules become Durable Objects), Hono, TypeScript, pnpm, Vitest (Node), Biome,
wrangler 4. Do not upgrade `@flue/*`: later versions delay Workers Observability
logs. Flue 2.0.0 needs the Agents SDK alongside it (`agents` 0.20.1),
`@earendil-works/pi-ai` stays at 0.83.0 (Flue 2.0.0's version), and `hono` is
pinned to 4.12.32 to match `@flue/github`. `@cloudflare/sandbox` is pinned to
0.12.14 and the `Dockerfile` base image must match it; Flue's
`cloudflareSandbox()` expects the 0.x API, so do not upgrade it to 1.x. Once a
container is configured, deploying builds its image locally, so Docker must be
running (amd64 emulation on Apple Silicon).

## Commands

`pnpm dev`, `pnpm run deploy` (not `pnpm deploy`), `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm cf-typegen`, `pnpm webhook:send`, `pnpm report`.
After any change run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and
report results honestly.

## Layout

- `src/app.ts`: the only HTTP surface. Mounts the GitHub channel; from checkpoint
  1 it calls `registerModelProviders(env)` and dispatches the agent from the
  channel's `onIssueOpened` hook.
- `src/github/webhook.ts` (provided): verified ingress, `webhook.received` log,
  and `openedIssue()`. If `onIssueOpened` is passed, it is called once per
  `issues: opened` delivery and logs `agent.dispatched` / `agent.dispatch_failed`.
- `src/models.ts` (provided): `registerModelProviders(env)` for `app.ts` and
  `modelFor(env)` for `useModel()`. Default: `cloudflare/@cf/zai-org/glm-4.7-flash`
  through the `AI` binding and the gateway named by `AI_GATEWAY_ID`. If the
  optional secrets `AI_GATEWAY_TOKEN` and `AI_GATEWAY_ACCOUNT_ID` are both set,
  model calls go over HTTP to that shared gateway instead.
- `src/agents/`: `'use agent'` modules and their Markdown instructions.
- `src/cloudflare.ts`: Worker-level exports (Durable Object, Workflow, container
  classes).
- `Dockerfile` (provided): the sandbox image.
- `tests/triage.test.ts`: all unit tests, in one file.

## Conventions

- Each new binding goes in `wrangler.jsonc`, followed by `pnpm cf-typegen`. Adding
  an agent or Durable Object class requires a new append-only migration entry;
  never edit a deployed one. Flue generates the `FLUE_*` agent bindings; do not
  declare them in `wrangler.jsonc`.
- Keep the webhook adapter thin. Signature verification happens inside the Flue
  GitHub channel before the handler runs. Modules that import
  `cloudflare:workers` (agents, `app.ts`) cannot be imported by unit tests.
- One agent instance (and sandbox) per issue: id `issue-<number>`.
- Log with one JSON object per line: `{"event": "<name>", ...fields}`.
- Every `sandbox.exec()` (ours and the agent's) runs in one shared bash session per
  sandbox. Never put `set -e`, `cd` or `export` at the top level of a command:
  wrap multi-line scripts with `strictScript()` and use the `cwd` option.
- Flue runs an agent's attempts inside one Durable Object alarm, which the
  platform stops after 15 minutes. `durability.timeoutMs` is one deadline for the
  whole run (all attempts), checked only between model turns, so keep it well
  below 15 minutes to leave room for a turn that is still running. When a
  Workflow waits on `read()`, only an `AgentRunError` is final; rethrow other
  errors so the step retries and re-attaches.
- Sandbox containers have a hard 30-minute lifetime (`src/sandbox.ts`, the class
  `src/cloudflare.ts` exports from checkpoint 1). The SDK's `sleepAfter` is only an
  idle timer and a hung command renews it. Keep any run's total time under that cap.
- Two-space indent, 100 columns (Biome). No code comments unless requested.

## Safety rules

- Never parse or act on a webhook before its signature is verified.
- Issue titles and bodies are untrusted. Never put them into shell commands,
  paths, URLs, configuration, or an agent's instructions; they reach an agent
  only as a message (signal).
- The workshop deliberately skips intake rules (repo allowlist, trusted authors,
  bots, size limits). Do not present this as production-ready.
- Secrets live in `wrangler secret` (deployed) or `.dev.vars` (local, gitignored).
  Never commit, log, or print them.
- Do not commit, push, deploy, or create GitHub issues unless asked.
