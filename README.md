# adlc triage agent

Starter for the ADLC workshop triage bot. Over the workshop you will turn this
Worker into an agent that reacts to new GitHub issues on your copy of the demo
order-tracker app, reproduces the bug in an isolated sandbox, and reports back on
the issue.

**Checkpoint 0 (this branch):** a Cloudflare Worker that receives GitHub webhook
deliveries, verifies their signature, and logs them. Nothing else happens yet.

## Stack

[Flue](https://flueframework.com/) on the Cloudflare target (Vite build), Hono,
TypeScript, pnpm, Vitest, Biome. Dependencies for later checkpoints (Cloudflare
Sandbox, Valibot) are already installed so you only run `pnpm install` once.

## Setup

You need Node 22+, pnpm 10, a Cloudflare account (provided on the day), and a
public fork of the demo app on GitHub.

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

## See the webhook in observability

Open an issue on your fork, then use either:

- **Live:** `pnpm exec wrangler tail adlc-triage-agent --format pretty` (start it first; it
  can take up to 30 seconds after "Connected" before logs stream)
- **Dashboard:** Workers & Pages → `adlc-triage-agent` → **Observability** → Logs

Each verified delivery logs one line:

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

In GitHub, **Recent Deliveries** shows the response `{"status":"received",…}`.
Editing, labelling, or commenting on the issue also produces deliveries; at this
checkpoint every verified delivery is logged.

## Local development (optional)

```sh
cp .dev.vars.example .dev.vars   # set GITHUB_WEBHOOK_SECRET
pnpm dev                         # http://localhost:5173
pnpm webhook:send --title "Test issue" --body-file issue.md --repo <you>/adlc-demo-app
```

`webhook:send` signs a fake `issues: opened` delivery with the secret from
`.dev.vars`. Add `--url https://<your-worker>.workers.dev/channels/github/webhook`
to send it to the deployed Worker instead (the secrets must match).

## Commands

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`          | Local dev server at http://localhost:5173.                                 |
| `pnpm run deploy`   | Build and deploy the Worker.                                               |
| `pnpm webhook:send` | Send a signed fake issue webhook (`--dry-run` to print it).                |
| `pnpm lint`         | Biome check (`pnpm format` to fix).                                        |
| `pnpm typecheck`    | `tsc --noEmit`.                                                            |
| `pnpm test`         | Unit tests.                                                                |
| `pnpm build`        | Production bundle into `dist/`.                                            |
| `pnpm cf-typegen`   | Regenerate `src/worker-configuration.d.ts` after editing `wrangler.jsonc`. |

## Layout

```
src/app.ts                 HTTP routes (Flue keeps all routing here)
src/github/webhook.ts      verified GitHub ingress: logs each delivery
tests/webhook.test.ts      ingress tests
scripts/send-test-webhook.ts
wrangler.jsonc             Worker config: no bindings yet
```

## Next: checkpoint 1

Add the reproduction agent: a Flue agent with a Workers AI model and a Cloudflare
Sandbox it can run commands in. That checkpoint adds the `AI` binding, the sandbox
container, and the agent's Durable Object migration to `wrangler.jsonc`.
