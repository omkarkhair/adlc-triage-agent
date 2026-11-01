import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai";
import type { FlueEvent } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";
import { activityRecord } from "../src/activity";
import { commentMarker, GitHubClient } from "../src/github/client";
import { createTriageChannel, type OpenedIssue, summarizeDelivery } from "../src/github/webhook";
import {
  modelFor,
  sharedGatewayFrom,
  sharedGatewayProvider,
  withDeadline,
  withModelTimeout,
} from "../src/models";
import {
  collectTestFile,
  decideOutcome,
  type FileSandbox,
  interpretVitest,
  runTestOnBase,
  type Verification,
} from "../src/verify";
import { type ExecLike, prepareWorkspace, strictScript } from "../src/workspace";

const SECRET = "test-webhook-secret";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const issueOpened = JSON.stringify({
  action: "opened",
  issue: { number: 3, title: "Bug", body: "Body", user: { login: "alice", type: "User" } },
  repository: { id: 99, full_name: "acme/demo-app", default_branch: "trunk" },
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
      defaultBranch: "trunk",
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

describe("model request deadline", () => {
  it("passes a fast result through", async () => {
    await expect(withDeadline(async () => "ok", 1_000)).resolves.toBe("ok");
  });

  it("fails a request that never answers and aborts it", async () => {
    let aborted = false;
    const never = (signal: AbortSignal) =>
      new Promise<string>(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      });
    await expect(withDeadline(never, 20)).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
  });

  it("fails a streamed response whose body stops arriving", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });
    const response = await withDeadline(
      async () => new Response(stalled, { headers: { "cf-aig-log-id": "log-1" } }),
      30,
    );
    expect(response.headers.get("cf-aig-log-id")).toBe("log-1");
    await expect(response.text()).rejects.toThrow("timed out");
  });

  it("lets a complete streamed body through", async () => {
    const response = await withDeadline(async () => new Response("all of it"), 1_000);
    await expect(response.text()).resolves.toBe("all of it");
  });

  it("adds an abort signal to every Workers AI binding call", async () => {
    const run = vi.fn(async () => ({ response: "ok" }));
    const result = await withModelTimeout({ run }, 1_000).run("@cf/m", { prompt: "hi" }, { a: 1 });
    expect(result).toEqual({ response: "ok" });
    const options = (run.mock.calls[0] as unknown[])[2] as { a: number; signal: unknown };
    expect(options.a).toBe(1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("activityRecord", () => {
  const base = { v: 3, eventIndex: 0, timestamp: "", instanceId: "issue-7" } as const;
  const record = (event: object) => activityRecord({ ...base, ...event } as FlueEvent);

  it("logs attempts, turn starts and tool calls", () => {
    expect(
      record({
        type: "submission_running",
        submissionId: "s",
        kind: "dispatch",
        attemptCount: 2,
        maxAttempts: 2,
      }),
    ).toEqual({ event: "agent.attempt", agentId: "issue-7", attempt: 2, maxAttempts: 2 });
    expect(record({ type: "turn_start", turnId: "t1", purpose: "agent" })).toEqual({
      event: "turn.started",
      agentId: "issue-7",
      turnId: "t1",
    });
    expect(
      record({ type: "tool", toolName: "bash", toolCallId: "c", isError: false, durationMs: 5 }),
    ).toEqual({
      event: "tool.finished",
      agentId: "issue-7",
      tool: "bash",
      isError: false,
      durationMs: 5,
    });
  });

  it("summarizes a finished turn without its content", () => {
    expect(
      record({
        type: "turn",
        turnId: "t1",
        purpose: "agent",
        durationMs: 900,
        isError: false,
        request: { providerId: "p", providerName: "p", requestedModel: "m", api: "a" },
        response: {
          finishReason: "toolUse",
          usage: { output: 42 },
          output: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret plan" },
              { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
            ],
          },
        },
      }),
    ).toEqual({
      event: "turn.finished",
      agentId: "issue-7",
      turnId: "t1",
      durationMs: 900,
      finishReason: "toolUse",
      toolCalls: ["bash"],
      outputTokens: 42,
      isError: false,
      error: null,
    });
  });

  it("ignores streaming deltas", () => {
    expect(record({ type: "text_delta", text: "hi" })).toBeNull();
  });
});

describe("GitHubClient", () => {
  const SHA = "a".repeat(40);
  type Call = { method: string; url: string; headers: Headers; body: unknown };

  function fakeGitHub(handler: (call: Call) => Response) {
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(url),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  it("resolves a branch to a pinned sha with the token", async () => {
    const gh = fakeGitHub(() => new Response(`${SHA}\n`));
    const client = new GitHubClient(" tok ", gh.fetch);
    await expect(client.resolveBranchHead("acme/demo-app", "main")).resolves.toBe(SHA);
    expect(gh.calls[0]?.url).toBe("https://api.github.com/repos/acme/demo-app/commits/main");
    expect(gh.calls[0]?.headers.get("accept")).toBe("application/vnd.github.sha");
    expect(gh.calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("rejects a bad repository name and a bad sha", async () => {
    const client = new GitHubClient("tok", fakeGitHub(() => new Response("not-a-sha")).fetch);
    await expect(client.resolveBranchHead("acme/demo-app", "main")).rejects.toThrow("invalid");
    await expect(client.resolveBranchHead("../x", "main")).rejects.toThrow("Invalid repository");
  });

  it("creates a comment when none carries the marker", async () => {
    const marker = commentMarker("issue-3", "triage");
    const gh = fakeGitHub((call) =>
      call.method === "GET"
        ? Response.json([{ id: 1, body: "someone else" }])
        : Response.json({ id: 42 }),
    );
    const result = await new GitHubClient("tok", gh.fetch).upsertComment(
      "acme/demo-app",
      3,
      marker,
      "hello",
    );
    expect(result).toEqual({ commentId: 42, action: "created" });
    expect(gh.calls[1]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/demo-app/issues/3/comments",
      body: { body: `${marker}\nhello` },
    });
  });

  it("updates our earlier comment instead of posting twice", async () => {
    const marker = commentMarker("issue-3", "triage");
    const gh = fakeGitHub((call) =>
      call.method === "GET"
        ? Response.json([{ id: 7, body: `${marker}\nold` }])
        : Response.json({ id: 7 }),
    );
    const result = await new GitHubClient("tok", gh.fetch).upsertComment(
      "acme/demo-app",
      3,
      marker,
      "new",
    );
    expect(result).toEqual({ commentId: 7, action: "updated" });
    expect(gh.calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/acme/demo-app/issues/comments/7",
    });
  });

  it("refuses to comment without a token", async () => {
    const client = new GitHubClient("", fakeGitHub(() => Response.json([])).fetch);
    expect(client.canWrite).toBe(false);
    await expect(client.upsertComment("acme/demo-app", 3, "<!-- m -->", "x")).rejects.toThrow(
      "GITHUB_TOKEN",
    );
  });

  it("reports GitHub errors with the status", async () => {
    const client = new GitHubClient(
      "tok",
      fakeGitHub(() => new Response("", { status: 404 })).fetch,
    );
    await expect(client.resolveBranchHead("acme/demo-app", "main")).rejects.toThrow("404");
  });
});

describe("prepareWorkspace", () => {
  const SHA = "b".repeat(40);

  function fakeSandbox(results: { exitCode: number; stdout?: string; stderr?: string }[]) {
    const commands: { command: string; cwd?: string }[] = [];
    const sandbox: ExecLike = {
      async exec(command, options) {
        commands.push({ command, cwd: options?.cwd });
        const next = results.shift() ?? { exitCode: 0 };
        return { stdout: "", stderr: "", ...next };
      },
    };
    return { sandbox, commands };
  }

  it("checks out the pinned sha, then installs", async () => {
    const { sandbox, commands } = fakeSandbox([
      { exitCode: 0, stdout: `${SHA}\n` },
      { exitCode: 0 },
    ]);
    await expect(prepareWorkspace(sandbox, "acme/demo-app", SHA)).resolves.toEqual({ sha: SHA });
    expect(commands[0]?.command).toContain(`fetch -q --depth 1 origin ${SHA}`);
    expect(commands[0]?.command).toContain("https://github.com/acme/demo-app.git");
    expect(commands[1]).toEqual({
      command: "pnpm install --frozen-lockfile --reporter=append-only",
      cwd: "/workspace",
    });
  });

  it("fails when the checkout lands on another commit", async () => {
    const { sandbox } = fakeSandbox([{ exitCode: 0, stdout: "c".repeat(40) }]);
    await expect(prepareWorkspace(sandbox, "acme/demo-app", SHA)).rejects.toThrow("expected");
  });

  it("fails with the tail of the output when install fails", async () => {
    const { sandbox } = fakeSandbox([
      { exitCode: 0, stdout: SHA },
      { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" },
    ]);
    await expect(prepareWorkspace(sandbox, "acme/demo-app", SHA)).rejects.toThrow(
      "pnpm install failed: ERR_PNPM_OUTDATED_LOCKFILE",
    );
  });

  it("refuses input that could break out of the shell command", async () => {
    const { sandbox, commands } = fakeSandbox([]);
    await expect(prepareWorkspace(sandbox, "acme/x;rm -rf /", SHA)).rejects.toThrow("invalid");
    await expect(prepareWorkspace(sandbox, "acme/demo-app", "HEAD")).rejects.toThrow("invalid");
    expect(commands).toHaveLength(0);
  });
});

describe("trusted verification", () => {
  const SHA = "d".repeat(40);
  const test = { path: "tests/triage/issue-7.test.ts", content: "it()", sha256: "abc" };
  const vitest = (suite: object, counts: object = {}) =>
    JSON.stringify({ numFailedTests: 0, numPassedTests: 0, testResults: [suite], ...counts });

  it("calls an assertion failure red", () => {
    const raw = vitest(
      {
        status: "failed",
        message: "",
        assertionResults: [
          {
            fullName: "orders dedupe",
            status: "failed",
            failureMessages: ["\u001b[31mAssertionError: expected 2 to be 1\u001b[39m"],
          },
        ],
      },
      { numFailedTests: 1 },
    );
    const result = interpretVitest(raw, 1, test);
    expect(result.status).toBe("red");
    expect(result.failures).toEqual([
      { name: "orders dedupe", message: "AssertionError: expected 2 to be 1" },
    ]);
  });

  it("does not count a crash as a reproduction", () => {
    const raw = vitest(
      {
        status: "failed",
        assertionResults: [
          { status: "failed", failureMessages: ["TypeError: x is not a function"] },
        ],
      },
      { numFailedTests: 1 },
    );
    expect(interpretVitest(raw, 1, test)).toMatchObject({
      status: "invalid",
      reason: "the test failed with an error, not a failed assertion",
    });
  });

  it("calls a test file that fails to load invalid", () => {
    const raw = vitest({
      status: "failed",
      message: "Cannot find module './nope'",
      assertionResults: [],
    });
    expect(interpretVitest(raw, 1, test).reason).toContain("Cannot find module");
  });

  it("calls an all-passing run green and a missing report invalid", () => {
    const raw = vitest(
      { status: "passed", assertionResults: [{ status: "passed" }] },
      { numPassedTests: 1 },
    );
    expect(interpretVitest(raw, 0, test).status).toBe("green");
    expect(interpretVitest("", 1, test).status).toBe("invalid");
  });

  it("only keeps a claimed reproduction that was red", () => {
    const red = { status: "red", reason: "1 test(s) failed" } as Verification;
    const green = { status: "green", reason: "every test passed" } as Verification;
    expect(decideOutcome("reproduced", red)).toMatchObject({
      outcome: "reproduced",
      verified: true,
    });
    expect(decideOutcome("reproduced", green)).toMatchObject({
      outcome: "cannot-reproduce",
      claimed: "reproduced",
      verified: false,
      note: "Downgraded from reproduced: every test passed.",
    });
    expect(decideOutcome("reproduced", null).outcome).toBe("cannot-reproduce");
    expect(decideOutcome("needs-information", null)).toMatchObject({
      outcome: "needs-information",
      verified: false,
    });
  });

  function fakeSandbox(handler: (command: string) => { exitCode: number; stdout?: string }) {
    const commands: string[] = [];
    const files = new Map<string, string>([["/workspace/tests/triage/issue-7.test.ts", "it()"]]);
    const sandbox: FileSandbox = {
      async exec(command) {
        commands.push(command);
        return { stdout: "", stderr: "", ...handler(command) };
      },
      async readFile(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error("not found");
        return { content };
      },
      async writeFile(path, content) {
        files.set(path, content);
      },
    };
    return { sandbox, commands, files };
  }

  it("collects the test with its digest and refuses paths outside tests/", async () => {
    const { sandbox } = fakeSandbox(() => ({ exitCode: 0 }));
    const file = await collectTestFile(sandbox, "tests/triage/issue-7.test.ts");
    expect(file.content).toBe("it()");
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(collectTestFile(sandbox, "src/index.ts")).rejects.toThrow("under tests/");
    await expect(collectTestFile(sandbox, "tests/../src/x.test.ts")).rejects.toThrow(
      "under tests/",
    );
  });

  it("resets to the base commit, writes back only the test, and reads vitest's report", async () => {
    const report = vitest(
      { status: "passed", assertionResults: [{ status: "passed" }] },
      { numPassedTests: 1 },
    );
    const { sandbox, commands, files } = fakeSandbox((command) => {
      if (command.includes("git reset")) return { exitCode: 0, stdout: `${SHA}\n` };
      if (command.startsWith("cat ")) return { exitCode: 0, stdout: report };
      return { exitCode: 0 };
    });
    const result = await runTestOnBase(sandbox, SHA, { ...test, content: "fresh" });
    expect(result.status).toBe("green");
    expect(commands[0]).toContain(`git reset -q --hard ${SHA}`);
    expect(commands[0]).toContain("git clean -fdq");
    expect(
      commands.some((c) => c.includes("vitest run 'tests/triage/issue-7.test.ts' --reporter=json")),
    ).toBe(true);
    expect(files.get("/workspace/tests/triage/issue-7.test.ts")).toBe("fresh");
  });

  it("fails loudly when the reset does not land on the base commit", async () => {
    const { sandbox } = fakeSandbox(() => ({ exitCode: 0, stdout: "e".repeat(40) }));
    await expect(runTestOnBase(sandbox, SHA, test)).rejects.toThrow("Could not reset");
  });
});

describe("strictScript in a shared shell session", () => {
  // Feeds several "exec calls" to one bash process, like the sandbox's default session.
  const session = (...calls: string[]) =>
    spawnSync("bash", { input: `${calls.join("\n")}\n`, encoding: "utf8" });

  it("shows the bug: a top-level set -e kills the session at the next failure", () => {
    const run = session("set -e; echo reset", "false", "echo report");
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("reset\n");
  });

  it("stops at the first failing line of its own script", () => {
    const run = session(strictScript(["echo one", "false", "echo two"]), "echo exit=$?");
    expect(run.stdout).toBe("one\nexit=1\n");
  });

  it("leaves no set -e and no cd behind for later commands", () => {
    const run = session(
      strictScript(["cd /tmp", "echo inside"]),
      "false",
      'echo "alive flags=$- dir=$PWD"',
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("inside");
    expect(run.stdout).not.toMatch(/flags=\S*e/);
    expect(run.stdout).not.toContain("dir=/tmp");
  });

  it("is used by every multi-line command the helpers send", async () => {
    const SHA = "f".repeat(40);
    const commands: string[] = [];
    const sandbox: FileSandbox = {
      async exec(command) {
        commands.push(command);
        if (command.startsWith("cat ")) return { exitCode: 0, stdout: "{}", stderr: "" };
        return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      },
      async readFile() {
        return { content: "it()" };
      },
      async writeFile() {},
    };
    await prepareWorkspace(sandbox, "acme/demo-app", SHA);
    await runTestOnBase(sandbox, SHA, { path: "tests/a.test.ts", content: "it()", sha256: "x" });
    for (const command of commands) {
      if (command.includes("set -e")) {
        expect(command.startsWith("(\nset -e\n")).toBe(true);
        expect(command.endsWith("\n)")).toBe(true);
      }
    }
    expect(commands.filter((c) => c.includes("set -e"))).toHaveLength(2);
  });
});
