import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { logAgentActivity } from "./activity";
import { createTriageChannel, type OpenedIssue } from "./github/webhook";
import { registerModelProviders } from "./models";

registerModelProviders(env);
logAgentActivity();

// One Workflow run per issue. The run id is the issue's agent id (issue-<n>), so a second
// delivery for the same issue can't start a second run: create() fails and the run exists.
async function startTriage(issue: OpenedIssue): Promise<void> {
  try {
    await env.TRIAGE_WORKFLOW.create({ id: issue.agentId, params: issue });
  } catch (error) {
    const existing = await env.TRIAGE_WORKFLOW.get(issue.agentId).catch(() => null);
    if (!existing) {
      throw error;
    }
    console.log(
      JSON.stringify({
        event: "run.duplicate",
        runId: issue.agentId,
        deliveryId: issue.deliveryId,
      }),
    );
  }
}

let githubIngress: Hono | undefined;

function getGitHubIngress(secret: string): Hono {
  if (!githubIngress) {
    const channel = createTriageChannel({ webhookSecret: secret, onIssueOpened: startTriage });
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
