# adlc triage agent

Starter for the ADLC workshop triage bot. Over the workshop you turn this Worker
into an agent that reacts to new GitHub issues on your copy of the demo
order-tracker app, reproduces the bug in an isolated sandbox, and reports back.

You build it in checkpoints. Each one has a solution branch you can switch to if
you fall behind (commit or stash your work, check out the branch, redeploy).

| Checkpoint                | What works at the end                                                         | Branch             |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| **0. Setup**              | A verified GitHub webhook reaches your Worker and is logged.                  | `dev/checkpoint-0` |
| **1. Agent in a sandbox** | A new issue starts an agent that tries to reproduce it and saves a report.    | `dev/checkpoint-1` |
| **2. Structured outcome** | The agent must submit a typed, validated result; the report is built from it. | `dev/checkpoint-2` |

## Stack

[Flue](https://flueframework.com/) on the Cloudflare target (Vite build), Hono,
TypeScript, pnpm, Vitest, Biome, Cloudflare Sandbox. Every dependency the workshop
needs is already in `package.json`, so you run `pnpm install` once.

## Prerequisites

- Node 22+ and pnpm 10.
- A Cloudflare account (provided on the day).
- A public fork of the demo app on GitHub, with Issues turned on.
- From checkpoint 1: **Docker**, running. `pnpm run deploy` builds the sandbox
  container image locally. On Apple Silicon, enable amd64 emulation (Rosetta).

## Setup (checkpoint 0)

1. Install and log in:

   ```sh
   pnpm install
   pnpm exec wrangler login
   ```

2. Deploy:

   ```sh
   pnpm run deploy
   ```

   Note the URL it prints, for example `https://adlc-triage-agent.<subdomain>.workers.dev`.
   Use `pnpm run deploy`, not `pnpm deploy` (that is a different, built-in pnpm command).

3. Create a webhook secret and give it to the Worker:

   ```sh
   openssl rand -hex 32
   pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
   ```

   Until the secret is set, the webhook answers `503 {"status":"unconfigured"}`.

4. Add a webhook to your demo-app fork: **Settings → Webhooks → Add webhook**.

   | Field        | Value                                                       |
   | ------------ | ----------------------------------------------------------- |
   | Payload URL  | `https://<your-worker>.workers.dev/channels/github/webhook` |
   | Content type | `application/json` (the default form encoding is rejected)  |
   | Secret       | the value from step 3                                       |
   | Events       | Let me select individual events → **Issues** only           |

   Saving sends a `ping`; **Recent Deliveries** should show a green tick (200).

5. Open an issue on your fork and watch the logs:
   - **Live:** `pnpm exec wrangler tail adlc-triage-agent --format pretty` (start it
     first; it can take up to 30 seconds after "Connected" before logs stream)
   - **Dashboard:** Workers & Pages → `adlc-triage-agent` → **Observability**

   Each verified delivery logs one line, and **Recent Deliveries** shows the
   response `{"status":"received",…}`:

   ```json
   {
     "event": "webhook.received",
     "deliveryId": "…",
     "githubEvent": "issues",
     "action": "opened",
     "repo": "<you>/adlc-demo-app",
     "issue": 1,
     "sender": "<you>"
   }
   ```

## Checkpoint 1: agent in a sandbox

Each newly opened issue starts a `Reproducer` agent. It runs a Workers AI model
with a Cloudflare Sandbox (a Linux container): it clones your fork, runs the
tests, writes a regression test for the reported bug, and ends by calling a
`save_report` tool that stores a Markdown report in R2.

You change `wrangler.jsonc` (AI, R2, and Sandbox bindings), `src/cloudflare.ts`,
and `src/app.ts`, and add `src/agents/reproducer.ts`, `src/agents/reproducer.md`,
and `src/reports.ts`. Run `pnpm cf-typegen` after editing `wrangler.jsonc`. The
helpers in `src/models.ts`, `src/github/webhook.ts`, and the `Dockerfile` are
provided.

### Account resources

The agent needs the R2 bucket `adlc-triage-reports` and the AI Gateway
`adlc-triage-agent`. Workshop accounts come with both. On your own account,
create them once:

```sh
pnpm exec wrangler r2 bucket create adlc-triage-reports
```

Then in the dashboard: **AI → AI Gateway → Create Gateway**, named
`adlc-triage-agent`.

### Deploy and run

```sh
pnpm run deploy   # Docker must be running; the first deploy takes a few minutes
```

Open a new issue on your fork (or use `pnpm webhook:send`, below). An
`issues: opened` delivery logs `agent.dispatched`, and **Recent Deliveries** shows
`{"status":"dispatched","agentId":"issue-<n>",…}`. Other actions (edited,
labeled, closed) are only logged.

The agent runs in the background. The first run waits for the container to start,
then clones, installs, and runs tests, so expect a few minutes. When it saves its
report you see `report.saved`, then:

```json
{
  "event": "agent.finished",
  "agentId": "issue-1",
  "issue": 1,
  "model": "cloudflare/@cf/zai-org/glm-4.7-flash",
  "reportSaved": true,
  "toolCalls": 14,
  "totalTokens": 48210
}
```

Read the report:

```sh
pnpm report 1    # prints runs/issue-1/report.md from the adlc-triage-reports bucket
```

`reportSaved: false` means the model stopped without calling the tool. For the
step-by-step detail (every model turn and command), open **Observability →
Traces** and find the `invoke_agent Reproducer` span; traces can take a few
minutes to appear. Model requests appear in **AI → AI Gateway →
`adlc-triage-agent`**.

Each issue gets its own agent instance and sandbox (`issue-<n>`). Another delivery
for the same issue number continues that conversation; use a new issue number for
a fresh run.

> **Workshop shortcut:** every opened issue starts an agent, which costs a
> container and model tokens. A production bot needs intake rules first (see the
> comment in `src/github/webhook.ts`).

### Optional: use a shared AI Gateway

If AI doesn't work in your account, the instructor can give you a token for a
shared AI Gateway in another account. Set two secrets and redeploy:

```sh
pnpm exec wrangler secret put AI_GATEWAY_TOKEN        # token from the instructor
pnpm exec wrangler secret put AI_GATEWAY_ACCOUNT_ID   # the gateway's account id
pnpm run deploy
```

The gateway name is still the `AI_GATEWAY_ID` var. With both secrets set, model
calls go over HTTP to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`
instead of your Workers AI binding, and `agent.finished` shows
`"model":"cloudflare-ai-gateway/workers-ai/@cf/zai-org/glm-4.7-flash"`. Model usage
is billed to the gateway's account; the sandbox, R2, and the Worker stay in yours.
To switch back, delete both secrets (`wrangler secret delete …`) and redeploy.

## Checkpoint 2: structured outcome

In checkpoint 1 the agent ends with free text, and nothing happens if it forgets
to call `save_report`. Now it must submit a **typed result**, and the harness
won't let it stop without one:

- `submit_outcome` replaces `save_report`. Its input is a schema: `outcome`
  (`reproduced`, `cannot-reproduce`, or `needs-information`), `summary`,
  `expected`, `observed`, and optional `testFile`, `missingInformation`, and
  `hypothesis`. Invalid input is rejected and the model sees the error and
  retries. Code also checks rules the schema can't express: `reproduced` needs a
  `testFile`, `needs-information` needs `missingInformation`.
- If the agent tries to stop without a successful `submit_outcome`, a finish hook
  sends it back with a reminder, at most `MAX_REMINDERS` (2) times.
- The R2 report is rendered from the fields by code, so every report has the
  same sections.

You add `src/outcome.ts` and change `src/agents/reproducer.ts`,
`src/agents/reproducer.md`, and `src/reports.ts`. No new bindings, so the redeploy
is quick.

```sh
pnpm run deploy
```

Open a new issue. In the logs you now see `outcome.submitted` with the result,
`agent.reminded` if the agent needed a nudge, and `agent.finished` with
`"outcomeSubmitted": true`. For issue 7, `pnpm report 7` prints:

```text
# Triage report: <you>/adlc-demo-app#7

- Agent: `issue-7`
- Saved: 2026-11-04T10:12:00.000Z

**Outcome:** `reproduced`

## Summary

…

## Expected

…

## Observed

…

## Test file

`tests/triage/issue-7.test.ts`
```

Try a vague issue too (for example "Orders are broken"): the agent should answer
`needs-information` and list what it needs.

The outcome is still the agent's own claim. Nothing re-runs its test yet.

## Sending test issues

```sh
cp .dev.vars.example .dev.vars   # set GITHUB_WEBHOOK_SECRET to the deployed value
pnpm webhook:send --url https://<your-worker>.workers.dev/channels/github/webhook \
  --repo <you>/adlc-demo-app --number 101 --title "Test issue" --body-file issue.md
```

`webhook:send` signs a fake `issues: opened` delivery with the secret from
`.dev.vars`. Use a new `--number` for a fresh agent. Without `--url` it targets
`pnpm dev` at http://localhost:5173 (local runs need Docker and a wrangler login).

## Commands

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`          | Local dev server at http://localhost:5173.                                 |
| `pnpm run deploy`   | Build and deploy the Worker.                                               |
| `pnpm webhook:send` | Send a signed fake issue webhook (`--dry-run` to print it).                |
| `pnpm report <n>`   | Print the agent's saved report for issue `<n>` from R2 (checkpoint 1+).    |
| `pnpm lint`         | Biome check (`pnpm format` to fix).                                        |
| `pnpm typecheck`    | `tsc --noEmit`.                                                            |
| `pnpm test`         | Unit tests.                                                                |
| `pnpm build`        | Production bundle into `dist/`.                                            |
| `pnpm cf-typegen`   | Regenerate `src/worker-configuration.d.ts` after editing `wrangler.jsonc`. |

## Layout

```
src/app.ts                 HTTP routes (Flue keeps all routing here)
src/github/webhook.ts      verified GitHub ingress; hands opened issues to app.ts
src/models.ts              provided: model choice, your gateway or a shared one
src/cloudflare.ts          Worker-level exports (cp1: the Sandbox container class)
src/agents/reproducer.ts   cp1: the agent (model, sandbox, tool); cp2: submit_outcome
src/agents/reproducer.md   cp1: the agent's instructions
src/reports.ts             cp1: writes the report to R2
src/outcome.ts             cp2: the outcome schema and its extra checks
Dockerfile                 provided: sandbox image, used from cp1
tests/triage.test.ts       unit tests
scripts/                   send-test-webhook.ts, show-report.ts
wrangler.jsonc             Worker config; each checkpoint adds its bindings
```
