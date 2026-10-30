import { createHmac } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createTriageChannel, type OpenedIssue, summarizeDelivery } from "../src/github/webhook";
import { modelFor, sharedGatewayFrom, sharedGatewayProvider } from "../src/models";

const SECRET = "test-webhook-secret";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const issueOpened = JSON.stringify({
  action: "opened",
  issue: { number: 3, title: "Bug", body: "Body", user: { login: "alice", type: "User" } },
  repository: { id: 99, full_name: "acme/demo-app" },
  sender: { login: "alice", type: "User" },
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function setup(
  onIssueOpened: ((issue: OpenedIssue) => Promise<void>) | null = vi.fn(async () => {}),
) {
  const log = vi.fn();
  const app = createTriageChannel({
    webhookSecret: SECRET,
    log,
    ...(onIssueOpened ? { onIssueOpened } : {}),
  }).route();
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
  return { send, log, onIssueOpened };
}

describe("GitHub webhook ingress", () => {
  it("accepts a signed delivery and logs a summary", async () => {
    const { send, log } = setup();
    const response = await send(issueOpened);
    expect(response.status).toBe(200);
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

describe("handing opened issues to the app", () => {
  it("only logs when no onIssueOpened hook is wired", async () => {
    const { send, log } = setup(null);
    const response = await send(issueOpened);
    expect(await response.json()).toEqual({
      status: "received",
      deliveryId: "delivery-1",
      event: "issues",
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("starts one agent per newly opened issue", async () => {
    const { send, log, onIssueOpened } = setup();
    const response = await send(issueOpened);
    expect(await response.json()).toEqual({
      status: "dispatched",
      deliveryId: "delivery-1",
      event: "issues",
      agentId: "issue-3",
    });
    expect(onIssueOpened).toHaveBeenCalledTimes(1);
    expect(onIssueOpened).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      agentId: "issue-3",
      repo: "acme/demo-app",
      issueNumber: 3,
      title: "Bug",
      body: "Body",
      author: "alice",
    });
    expect(log).toHaveBeenCalledWith("agent.dispatched", {
      deliveryId: "delivery-1",
      agentId: "issue-3",
      repo: "acme/demo-app",
      issue: 3,
    });
  });

  it("only logs other issue actions", async () => {
    const { send, onIssueOpened } = setup();
    const edited = issueOpened.replace('"opened"', '"edited"');
    const response = await send(edited, { "x-hub-signature-256": sign(edited) });
    expect(await response.json()).toEqual({
      status: "received",
      deliveryId: "delivery-1",
      event: "issues",
    });
    expect(onIssueOpened).not.toHaveBeenCalled();
  });

  it("does not dispatch for a malformed repository name", async () => {
    const { send, onIssueOpened } = setup();
    const odd = issueOpened.replace("acme/demo-app", "acme/demo app; rm -rf /");
    const response = await send(odd, { "x-hub-signature-256": sign(odd) });
    expect(response.status).toBe(200);
    expect(onIssueOpened).not.toHaveBeenCalled();
  });

  it("answers 500 and logs when the dispatch fails", async () => {
    const failing = vi.fn(async (_issue: OpenedIssue) => {
      throw new Error("admission rejected");
    });
    const { send, log } = setup(failing);
    const response = await send(issueOpened);
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledWith("agent.dispatch_failed", {
      deliveryId: "delivery-1",
      agentId: "issue-3",
      error: "admission rejected",
    });
    expect(log).not.toHaveBeenCalledWith("agent.dispatched", expect.anything());
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

describe("model selection", () => {
  it("uses the Workers AI binding when no shared gateway is configured", () => {
    const env = { AI_GATEWAY_ID: "adlc-triage-agent" };
    expect(sharedGatewayFrom(env)).toBeNull();
    expect(modelFor(env)).toBe("cloudflare/@cf/zai-org/glm-4.7-flash");
  });

  it("needs both the token and the account id for the shared gateway", () => {
    expect(sharedGatewayFrom({ AI_GATEWAY_ID: "g", AI_GATEWAY_TOKEN: "t" })).toBeNull();
    expect(sharedGatewayFrom({ AI_GATEWAY_ID: "g", AI_GATEWAY_ACCOUNT_ID: ACCOUNT })).toBeNull();
  });

  it("switches to the shared gateway model when both are set", () => {
    const env = {
      AI_GATEWAY_ID: "adlc-triage-agent",
      AI_GATEWAY_TOKEN: " token ",
      AI_GATEWAY_ACCOUNT_ID: ACCOUNT,
    };
    expect(sharedGatewayFrom(env)).toEqual({
      accountId: ACCOUNT,
      gatewayId: "adlc-triage-agent",
      token: "token",
    });
    expect(modelFor(env)).toBe("cloudflare-ai-gateway/workers-ai/@cf/zai-org/glm-4.7-flash");
  });

  it("rejects a malformed account id", () => {
    expect(() =>
      sharedGatewayFrom({
        AI_GATEWAY_ID: "g",
        AI_GATEWAY_TOKEN: "t",
        AI_GATEWAY_ACCOUNT_ID: "x/y",
      }),
    ).toThrow("32-character");
  });
});

describe("sharedGatewayProvider", () => {
  it("calls the gateway's compat endpoint with cf-aig-authorization only", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        id: "1",
        object: "chat.completion",
        created: 0,
        model: "@cf/zai-org/glm-4.7-flash",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const models = createModels();
      models.setProvider(
        sharedGatewayProvider({ accountId: ACCOUNT, gatewayId: "adlc-triage-agent", token: "tok" }),
      );
      const model = models.getModel(
        "cloudflare-ai-gateway",
        "workers-ai/@cf/zai-org/glm-4.7-flash",
      );
      expect(model).toBeDefined();
      if (!model) return;
      await models.completeSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] ?? [];
      const request = url instanceof Request ? url : new Request(String(url), init);
      expect(request.url).toBe(
        `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/adlc-triage-agent/compat/chat/completions`,
      );
      expect(request.headers.get("cf-aig-authorization")).toBe("Bearer tok");
      expect(request.headers.get("authorization")).toBeNull();
      const body = (await request.json()) as { model: string };
      expect(body.model).toBe("workers-ai/@cf/zai-org/glm-4.7-flash");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
