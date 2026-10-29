import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTriageChannel, summarizeDelivery } from "../src/github/webhook";

const SECRET = "test-webhook-secret";

const issueOpened = JSON.stringify({
  action: "opened",
  issue: { number: 3, title: "Bug", body: "Body", user: { login: "alice", type: "User" } },
  repository: { id: 99, full_name: "acme/demo-app" },
  sender: { login: "alice", type: "User" },
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function setup() {
  const log = vi.fn();
  const app = createTriageChannel({ webhookSecret: SECRET, log }).route();
  const send = (body: string, headers: Record<string, string> = {}) =>
    app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": sign(body),
        ...headers,
      },
      body,
    });
  return { send, log };
}

describe("GitHub webhook ingress", () => {
  it("accepts a signed delivery and logs a summary", async () => {
    const { send, log } = setup();
    const response = await send(issueOpened);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "received",
      deliveryId: "delivery-1",
      event: "issues",
    });
    expect(log).toHaveBeenCalledWith("webhook.received", {
      deliveryId: "delivery-1",
      githubEvent: "issues",
      action: "opened",
      repo: "acme/demo-app",
      issue: 3,
      sender: "alice",
    });
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const { send, log } = setup();
    const response = await send(issueOpened, {
      "x-hub-signature-256": sign(issueOpened, "wrong"),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects a body modified after signing", async () => {
    const { send, log } = setup();
    const response = await send(issueOpened.replace("Bug", "Changed"), {
      "x-hub-signature-256": sign(issueOpened),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects form-encoded deliveries", async () => {
    const { send } = setup();
    const response = await send(issueOpened, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(415);
  });

  it("answers GitHub's ping without logging a delivery", async () => {
    const { send, log } = setup();
    const ping = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    const response = await send(ping, { "x-github-event": "ping" });
    expect(response.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("summarizeDelivery", () => {
  it("tolerates payloads without issue or repository fields", () => {
    expect(summarizeDelivery("ping", "d", { zen: "hi" })).toEqual({
      deliveryId: "d",
      githubEvent: "ping",
      action: null,
      repo: null,
      issue: null,
      sender: null,
    });
  });
});
