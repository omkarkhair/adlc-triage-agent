import { env } from "cloudflare:workers";
import { dispatch } from "@flue/runtime";
import { Hono } from "hono";
import { logAgentActivity } from "./activity";
import { Reproducer, type ReproducerData } from "./agents/reproducer";
import { createTriageChannel, type OpenedIssue } from "./github/webhook";
import { registerModelProviders } from "./models";

registerModelProviders(env);
logAgentActivity();

async function startReproducer(issue: OpenedIssue): Promise<void> {
  const initialData: ReproducerData = { repo: issue.repo, issueNumber: issue.issueNumber };
  await dispatch(Reproducer, {
    id: issue.agentId,
    idempotencyKey: issue.deliveryId,
    initialData,
    message: {
      kind: "signal",
      type: "github.issue.opened",
      tagName: "issue",
      attributes: {
        repository: issue.repo,
        number: String(issue.issueNumber),
        author: issue.author,
      },
      body: `Title: ${issue.title}\n\n${issue.body}`,
    },
  });
}

let githubIngress: Hono | undefined;

function getGitHubIngress(secret: string): Hono {
  if (!githubIngress) {
    const channel = createTriageChannel({ webhookSecret: secret, onIssueOpened: startReproducer });
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
