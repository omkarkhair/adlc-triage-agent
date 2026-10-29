import { createGitHubChannel, type GitHubChannel } from "@flue/github";

export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export interface DeliverySummary {
  deliveryId: string;
  githubEvent: string;
  action: string | null;
  repo: string | null;
  issue: number | null;
  sender: string | null;
}

interface LooseIssuesPayload {
  action?: unknown;
  issue?: { number?: unknown };
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

export interface WebhookDeps {
  webhookSecret: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export function createTriageChannel(deps: WebhookDeps): GitHubChannel {
  const log = deps.log ?? ((event, fields) => console.log(JSON.stringify({ event, ...fields })));
  return createGitHubChannel({
    webhookSecret: deps.webhookSecret,
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    webhook({ delivery }) {
      const summary = summarizeDelivery(delivery.name, delivery.deliveryId, delivery.payload);
      log("webhook.received", { ...summary });
      return {
        status: "received",
        deliveryId: summary.deliveryId,
        event: summary.githubEvent,
      };
    },
  });
}
