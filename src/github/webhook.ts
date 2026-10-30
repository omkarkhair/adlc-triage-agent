import { createGitHubChannel, type GitHubChannel } from "@flue/github";

export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

const REPO_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface DeliverySummary {
  deliveryId: string;
  githubEvent: string;
  action: string | null;
  repo: string | null;
  issue: number | null;
  sender: string | null;
}

export interface OpenedIssue {
  deliveryId: string;
  agentId: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  author: string;
}

interface LooseIssuesPayload {
  action?: unknown;
  issue?: { number?: unknown; title?: unknown; body?: unknown; user?: { login?: unknown } };
  repository?: { full_name?: unknown };
  sender?: { login?: unknown };
}

export function summarizeDelivery(
  event: string,
  deliveryId: string,
  payload: unknown,
): DeliverySummary {
  const body = (payload ?? {}) as LooseIssuesPayload;
  return {
    deliveryId,
    githubEvent: event,
    action: typeof body.action === "string" ? body.action : null,
    repo: typeof body.repository?.full_name === "string" ? body.repository.full_name : null,
    issue: typeof body.issue?.number === "number" ? body.issue.number : null,
    sender: typeof body.sender?.login === "string" ? body.sender.login : null,
  };
}

export function agentIdFor(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

export function openedIssue(summary: DeliverySummary, payload: unknown): OpenedIssue | null {
  if (summary.githubEvent !== "issues" || summary.action !== "opened") {
    return null;
  }
  if (!summary.repo || !REPO_FULL_NAME.test(summary.repo) || summary.issue === null) {
    return null;
  }
  const issue = (payload as LooseIssuesPayload).issue ?? {};
  return {
    deliveryId: summary.deliveryId,
    agentId: agentIdFor(summary.issue),
    repo: summary.repo,
    issueNumber: summary.issue,
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.body === "string" ? issue.body : "",
    author: typeof issue.user?.login === "string" ? issue.user.login : "unknown",
  };
}

export interface WebhookDeps {
  webhookSecret: string;
  onIssueOpened?: (issue: OpenedIssue) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export function createTriageChannel(deps: WebhookDeps): GitHubChannel {
  const log = deps.log ?? ((event, fields) => console.log(JSON.stringify({ event, ...fields })));
  return createGitHubChannel({
    webhookSecret: deps.webhookSecret,
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    async webhook({ c, delivery }): Promise<Record<string, string> | Response> {
      const summary = summarizeDelivery(delivery.name, delivery.deliveryId, delivery.payload);
      log("webhook.received", { ...summary });

      // Workshop shortcut: every newly opened issue on the webhook's repository starts an agent.
      // A production bot needs intake rules here before dispatching: an allowlist of
      // repositories, trusted authors only, skip bots and pull requests, and size limits on
      // the title and body. Each accepted issue costs a container and model tokens.
      const issue = openedIssue(summary, delivery.payload);
      if (!issue || !deps.onIssueOpened) {
        return { status: "received", deliveryId: summary.deliveryId, event: summary.githubEvent };
      }

      try {
        await deps.onIssueOpened(issue);
      } catch (error) {
        log("agent.dispatch_failed", {
          deliveryId: issue.deliveryId,
          agentId: issue.agentId,
          error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
        return c.json({ status: "dispatch_failed", deliveryId: issue.deliveryId }, 500);
      }

      log("agent.dispatched", {
        deliveryId: issue.deliveryId,
        agentId: issue.agentId,
        repo: issue.repo,
        issue: issue.issueNumber,
      });
      return {
        status: "dispatched",
        deliveryId: issue.deliveryId,
        event: summary.githubEvent,
        agentId: issue.agentId,
      };
    },
  });
}
