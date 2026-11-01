import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { logAgentActivity } from "./activity";
import { createTriageChannel } from "./github/webhook";

logAgentActivity();

let githubIngress: Hono | undefined;

function getGitHubIngress(secret: string): Hono {
  if (!githubIngress) {
    const channel = createTriageChannel({ webhookSecret: secret });
    githubIngress = new Hono().route("/channels/github", channel.route());
  }
  return githubIngress;
}

const app = new Hono();

app.get("/", (c) =>
  c.text("adlc triage agent: POST GitHub issue webhooks to /channels/github/webhook\n"),
);

app.all("/channels/github/*", (c) => {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(JSON.stringify({ event: "webhook.unconfigured" }));
    return c.json({ status: "unconfigured" }, 503);
  }
  return getGitHubIngress(secret).fetch(c.req.raw);
});

export default app;
