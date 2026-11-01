# adlc triage agent

Starter for the ADLC workshop triage bot. Over the workshop you turn this Worker
into an agent that reacts to new GitHub issues on your copy of the demo
order-tracker app, reproduces the bug in an isolated sandbox, and reports back.

You build it in checkpoints. Each one has a solution branch you can switch to if
you fall behind (commit or stash your work, check out the branch, redeploy).

| Checkpoint                  | What works at the end                                                                                                       | Branch             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **0. Setup**                | A verified GitHub webhook reaches your Worker and is logged.                                                                | `dev/checkpoint-0` |
| **1. Agent in a sandbox**   | A new issue starts an agent that tries to reproduce it and saves a report.                                                  | `dev/checkpoint-1` |
| **2. Structured outcome**   | The agent must submit a typed, validated result; the report is built from it.                                               | `dev/checkpoint-2` |
| **3. Workflow and comment** | A new issue starts one durable run that checks out your fork at a pinned commit, runs the agent, and comments on the issue. | `dev/checkpoint-3` |
| **4. Trusted verification** | The run re-runs the agent's test on a clean checkout and only confirms a reproduction it saw fail.                          | `dev/checkpoint-4` |
| **5. Fix and verify**       | A second agent proposes a fix; a fresh sandbox checks red to green and every project check before it counts.                | `dev/checkpoint-5` |

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

While the agent works, the logs also show one line per step (from
`src/activity.ts`): `agent.attempt` when an attempt starts, `turn.started` and
`turn.finished` around each model call (with its duration and the tools it asked
for), and `tool.finished` after each tool call. If the last line is
`turn.started`, the agent is waiting for the model. A model request that takes
longer than 120 seconds is cut off and retried (`MODEL_REQUEST_TIMEOUT_MS` in
`src/models.ts`).

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
`needs-information` within a minute or so, without cloning the app, and list what
it needs.

The outcome is still the agent's own claim. Nothing re-runs its test yet.

## Checkpoint 3: workflow and issue comment

Until now the webhook handler started the agent directly and nobody outside your
logs saw the result. Now each new issue starts a **Workflow** run that drives the
whole triage durably, step by step, and reports back on the issue:

1. **Resolve the base commit:** ask GitHub which commit your fork's default branch
   points at, and pin it. Everything in the run uses that exact commit.
2. **Post a "started" comment** on the issue.
3. **Prepare the workspace:** trusted code (not the agent) checks the pinned
   commit out in the sandbox and installs dependencies (`src/workspace.ts`).
4. **Run the agent** and wait for its outcome. `submit_outcome` now also hands the
   outcome back to the workflow (`useDataWriter`), not just to R2.
5. **Update the comment** with the outcome.

The run id is `issue-<number>`, the same as the agent and the sandbox. Workflows
refuse a second run with the same id, so a redelivered webhook can't start the
issue twice (the log says `run.duplicate`). Each step is retried on its own if it
fails, and a step that already finished is never run again.

You add `src/workflow.ts` and the Workflow binding in `wrangler.jsonc`, export the
class from `src/cloudflare.ts`, start the run from `src/app.ts`, and change
`src/agents/reproducer.ts` and `src/agents/reproducer.md`. The GitHub client
(`src/github/client.ts`) and the workspace helper are provided.

### Create a GitHub token

The Worker needs a token to comment on your fork (and, in later checkpoints, to
open a pull request). Create it once:

1. GitHub → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Expiration: 7 days. Repository access: **Only select repositories** → your
   demo-app fork.
3. Repository permissions: **Issues**, **Contents** and **Pull requests**: Read and
   write. (Metadata: Read-only is added automatically.)
4. Generate, copy the token, and give it to the Worker:

   ```sh
   pnpm exec wrangler secret put GITHUB_TOKEN
   ```

The token stays in the Worker. The sandbox, where the agent runs commands, never
sees it. Without the token the run still works, but logs `comment.skipped`.

### Deploy and test

```sh
pnpm run deploy
```

Open a **real** issue on your fork (the comment needs an issue to land on; a fake
`webhook:send` number that doesn't exist gives `comment.failed`). Within seconds
the issue gets a comment saying triage started at a pinned commit. A few minutes
later the same comment shows the outcome. The logs show the run:

```text
run.started        {"runId":"issue-12","repo":"<you>/adlc-demo-app","issue":12}
run.base           {"runId":"issue-12","sha":"3f2c…"}
comment.published  {"runId":"issue-12","kind":"started","action":"created"}
workspace.ready    {"runId":"issue-12","durationMs":41000}
…the agent's turn.* and tool.* lines, outcome.submitted, agent.finished…
comment.published  {"runId":"issue-12","kind":"outcome","action":"updated"}
run.finished       {"runId":"issue-12","outcome":"reproduced","failure":null}
```

To see each step, its retries and its output, open **Workers & Pages →
Workflows → `adlc-triage-run`** and pick the `issue-12` instance.

## Checkpoint 4: trusted verification

The comment from checkpoint 3 still repeats the agent's claim. A model can say
`reproduced` when its test passed, when the test crashed on a typo, or when it
changed the app's code while exploring. Now the run checks the claim itself
before anyone sees it (`src/verify.ts`, provided):

1. **Collect the test:** read the agent's test file out of the sandbox and record
   its SHA-256.
2. **Re-run it on the base commit:** reset the workspace to the pinned commit
   (`git reset --hard` + `git clean -fd`, which undoes anything the agent
   changed), write back only the test file, and run it with vitest's JSON
   reporter.
3. **Decide:** only a failed **assertion** counts as red. A test that fails to
   load or crashes proves nothing about the bug. A claimed `reproduced` stands
   only if the re-run was red; otherwise it is downgraded to `cannot-reproduce`
   and the report says why. The model can't argue with this step.
4. **Report:** the verified report (with a Verification section and the test's
   source) replaces the agent's report in R2, and the issue comment shows it.

You change `src/workflow.ts` (two new steps and the decision) and
`src/reports.ts` (the Verification section). No new bindings.

```sh
pnpm run deploy
```

Open a real issue. After `outcome.submitted` the logs show:

```text
test.collected         {"runId":"issue-13","testFile":"tests/triage/issue-13.test.ts","sha256":"9b1c…"}
verification.finished  {"runId":"issue-13","status":"red","reason":"1 test(s) failed on an assertion"}
run.finished           {"runId":"issue-13","claimed":"reproduced","outcome":"reproduced","verified":true}
```

`pnpm report 13` and the issue comment now end with a **Verification** section:
the result, the failing assertion, and the test the agent wrote. If the claim was
downgraded you see `"verified":false` and the reason, for example "every test
passed" or "the test file failed to load".

## Checkpoint 5: fix and verify

With a verified reproduction, the run now asks a second agent, the **Fixer**, for
the smallest fix. As in checkpoint 4, the model's word is not enough. A fix only
becomes a **candidate** when trusted code has checked it:

1. **Fix:** the Fixer works in the issue's sandbox, starting from the base commit
   plus the verified regression test. It reads the demo app's
   `docs/practices.md` and `docs/architecture.md`, changes the code, runs the
   checks, and ends with a typed `submit_fix` (summary, rationale, files).
2. **Collect:** trusted code lists what changed (`src/candidate.ts`, provided).
   Only files under `src/` and **new** files under `migrations/` are taken. Any
   other change, including an edit to a test, is ignored and listed in the report.
3. **Verify in a fresh sandbox** (`issue-<n>-verify`), which the agent never
   touched: check out the base commit, install, run the **unchanged** regression
   test (must be red), apply the fix, run it again (must be green), then run the
   project's own checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
4. **Record:** if everything passed, the patch is stored in R2 as
   `candidate.patch` together with `candidate.json`, and its SHA-256 (the
   **digest**) names this exact candidate. A second comment on the issue shows the
   result, the checks, the files and the patch. A failed fix gets a comment with
   the reason and no candidate.

Why a second sandbox? The first one ran an agent's commands for minutes. It may
hold changed shell settings, edited files in `node_modules`, or files outside the
repository, none of which `git reset` undoes. A sandbox only trusted code has
used can't carry any of that into the result.

You add `src/agents/fixer.ts` and `src/agents/fixer.md`, add the fix steps to
`src/workflow.ts`, and in `wrangler.jsonc` add a migration for the new agent class
and allow more containers (each run now briefly uses two).

```sh
pnpm run deploy
```

Open a real issue. After the checkpoint 4 lines, the logs show the Fixer's turns
and then:

```text
fix.submitted      {"agentId":"issue-14","result":"fixed","files":["src/…"]}
fix.collected      {"runId":"issue-14","files":["src/…"],"ignored":[]}
candidate.checked  {"runId":"issue-14","status":"verified","digest":"5e0a…","checks":{"lint":0,"typecheck":0,"test":0,"build":0}}
candidate.saved    {"runId":"issue-14","patch":"runs/issue-14/candidate.patch"}
run.finished       {"runId":"issue-14","outcome":"reproduced","verified":true,"fix":"verified","digest":"5e0a…"}
```

Read the patch with `pnpm report 14 candidate.patch` (or `candidate.json` for the
whole record). Nothing has been pushed to your repository yet; checkpoint 6 turns
a verified candidate into a draft pull request.

## Sending test issues

```sh
cp .dev.vars.example .dev.vars   # set GITHUB_WEBHOOK_SECRET to the deployed value
pnpm webhook:send --url https://<your-worker>.workers.dev/channels/github/webhook \
  --repo <you>/adlc-demo-app --number 101 --title "Test issue" --body-file issue.md
```

`webhook:send` signs a fake `issues: opened` delivery with the secret from
`.dev.vars`. Use a new `--number` for a fresh agent. From checkpoint 3 the run
comments on the issue, so use the number of a real issue on your fork. Without `--url` it targets
`pnpm dev` at http://localhost:5173 (local runs need Docker and a wrangler login).

## Commands

| Command             | What it does                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`          | Local dev server at http://localhost:5173.                                     |
| `pnpm run deploy`   | Build and deploy the Worker.                                                   |
| `pnpm webhook:send` | Send a signed fake issue webhook (`--dry-run` to print it).                    |
| `pnpm report <n>`   | Print the report for issue `<n>` from R2 (cp1+); add `candidate.patch` (cp5+). |
| `pnpm lint`         | Biome check (`pnpm format` to fix).                                            |
| `pnpm typecheck`    | `tsc --noEmit`.                                                                |
| `pnpm test`         | Unit tests.                                                                    |
| `pnpm build`        | Production bundle into `dist/`.                                                |
| `pnpm cf-typegen`   | Regenerate `src/worker-configuration.d.ts` after editing `wrangler.jsonc`.     |

## Layout

```
src/app.ts                 HTTP routes (Flue keeps all routing here)
src/github/webhook.ts      verified GitHub ingress; hands opened issues to app.ts
src/models.ts              provided: model choice, your gateway or a shared one, request timeout
src/activity.ts            provided: logs each attempt, model turn and tool call
src/github/client.ts       provided: GitHub API calls (pin a commit, comment on an issue)
src/workspace.ts           provided: check out the pinned commit in the sandbox, install
src/verify.ts              provided: re-run the agent's test on the base commit, decide
src/candidate.ts           provided: collect a fix, check it in a fresh sandbox, store it
src/cloudflare.ts          Worker-level exports (cp1: the Sandbox class; cp3: the Workflow)
src/workflow.ts            cp3: the durable triage run, one per issue; cp4: verification; cp5: fix
src/agents/reproducer.ts   cp1: the agent (model, sandbox, tool); cp2: submit_outcome
src/agents/reproducer.md   cp1: the agent's instructions
src/agents/fixer.ts        cp5: the Fixer agent and its submit_fix tool
src/agents/fixer.md        cp5: the Fixer's instructions
src/reports.ts             cp1: writes the report to R2
src/outcome.ts             cp2: the outcome schema and its extra checks
Dockerfile                 provided: sandbox image, used from cp1
tests/triage.test.ts       unit tests
scripts/                   send-test-webhook.ts, show-report.ts
wrangler.jsonc             Worker config; each checkpoint adds its bindings
```
