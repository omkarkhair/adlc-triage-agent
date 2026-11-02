import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { AgentRunError, init } from "@flue/runtime";
import * as v from "valibot";
import { OUTCOME_PART, Reproducer, type ReproducerData } from "./agents/reproducer";
import { commentMarker, GitHubClient } from "./github/client";
import type { OpenedIssue } from "./github/webhook";
import { ReproOutcome } from "./outcome";
import { openTestPullRequest, type PullRequestResult } from "./pull-request";
import { renderReport, saveReport } from "./reports";
import { collectTestFile, decideOutcome, runTestOnBase, type Verification } from "./verify";
import { prepareWorkspace } from "./workspace";

const QUICK = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;
const SETUP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "constant" },
  timeout: "10 minutes",
} as const;
// A retry of a "wait" step reads the same agent run again (read() re-attaches), so a dropped
// connection doesn't lose the result. The sandbox has a hard 30-minute lifetime, so the wait and
// its retries stay under that: a sandbox that hits the cap makes the agent run fail and end.
const AGENT = {
  retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
  timeout: "25 minutes",
} as const;

interface AgentResult {
  outcome: ReproOutcome | null;
  failure: string | null;
}

function log(runId: string, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, runId, ...fields }));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown error";
}

/**
 * One durable triage run per issue (instance id `issue-<n>`). Each `step.do` is retried on its
 * own and its result is stored, so a step that finished never runs again after a restart. Code
 * outside steps (like the log lines) can run again when the run resumes, so keep it cheap.
 */
export class TriageWorkflow extends WorkflowEntrypoint<Env, OpenedIssue> {
  async run(event: WorkflowEvent<OpenedIssue>, step: WorkflowStep) {
    const issue = event.payload;
    const runId = event.instanceId;
    const github = new GitHubClient(this.env.GITHUB_TOKEN);
    const sandbox = getSandbox(this.env.Sandbox as DurableObjectNamespace<Sandbox>, runId);
    log(runId, "run.started", { repo: issue.repo, issue: issue.issueNumber });

    const comment = async (kind: string, text: string) => {
      if (!github.canWrite) {
        log(runId, "comment.skipped", { kind, reason: "GITHUB_TOKEN is not set" });
        return;
      }
      try {
        const result = await step.do(`comment: ${kind}`, QUICK, () =>
          github.upsertComment(issue.repo, issue.issueNumber, commentMarker(runId, "triage"), text),
        );
        log(runId, "comment.published", { kind, action: result.action });
      } catch (error) {
        log(runId, "comment.failed", { kind, error: describe(error) });
      }
    };

    let baseSha: string | null = null;
    let result: AgentResult = { outcome: null, failure: null };
    let verification: Verification | null = null;
    let testSource: string | null = null;
    try {
      // 1. Pin the commit the whole run works on.
      const sha = await step.do("resolve base commit", QUICK, () =>
        github.resolveBranchHead(issue.repo, issue.defaultBranch),
      );
      baseSha = sha;
      log(runId, "run.base", { sha });

      await comment(
        "started",
        `Triage started on commit \`${sha.slice(0, 7)}\`. An AI agent is trying to reproduce this issue.`,
      );

      // 2. Trusted code checks out the pinned commit; the agent never chooses what it runs on.
      const ready = await step.do("prepare workspace", SETUP, async () => {
        const started = Date.now();
        await prepareWorkspace(sandbox, issue.repo, sha);
        return { durationMs: Date.now() - started };
      });
      log(runId, "workspace.ready", ready);

      // 3. Hand the issue to the agent, then wait for its outcome.
      const agent = init(Reproducer, { id: runId });
      const initialData: ReproducerData = {
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        baseSha: sha,
      };
      const receipt = await step.do("start agent", QUICK, () =>
        agent.dispatch({
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
        }),
      );
      result = await step.do("wait for agent", AGENT, async (): Promise<AgentResult> => {
        try {
          const reply = await agent.read(receipt);
          const parsed = v.safeParse(ReproOutcome, reply.data[OUTCOME_PART]?.at(-1));
          return parsed.success
            ? { outcome: parsed.output, failure: null }
            : { outcome: null, failure: "the agent stopped without submitting an outcome" };
        } catch (error) {
          // The agent run itself failed: that is the answer. Anything else (a dropped connection,
          // a restarted Durable Object) is thrown so the step retries and reads again.
          if (error instanceof AgentRunError) {
            return { outcome: null, failure: describe(error) };
          }
          throw error;
        }
      });

      // 4. Don't trust the claim: re-run the agent's test on a clean checkout of the commit.
      const testFile = result.outcome?.testFile;
      if (result.outcome?.outcome === "reproduced" && testFile) {
        try {
          const test = await step.do("collect test", QUICK, () =>
            collectTestFile(sandbox, testFile),
          );
          log(runId, "test.collected", { testFile: test.path, sha256: test.sha256 });
          testSource = test.content;
          verification = await step.do("verify on base commit", SETUP, () =>
            runTestOnBase(sandbox, sha, test),
          );
        } catch (error) {
          verification = {
            status: "invalid",
            reason: describe(error),
            testFile,
            testSha256: null,
            passed: 0,
            failed: 0,
            failures: [],
          };
        }
        log(runId, "verification.finished", {
          status: verification.status,
          reason: verification.reason,
        });
      }
    } catch (error) {
      result = { outcome: null, failure: describe(error) };
    }

    // 5. The harness decides the outcome, stores the verified report, and tells the reporter.
    const outcome = result.outcome;
    const verdict = outcome ? decideOutcome(outcome.outcome, verification) : null;
    let pullRequest: PullRequestResult | null = null;
    if (outcome && verdict) {
      const context = { agentId: runId, repo: issue.repo, issueNumber: issue.issueNumber };
      const verified = { verdict, verification, testSource };
      try {
        const key = await step.do("save report", QUICK, () =>
          saveReport(this.env.REPORTS, context, outcome, new Date(), verified),
        );
        log(runId, "report.saved", { key });
      } catch (error) {
        log(runId, "report.failed", { error: describe(error) });
      }

      // 6. Hand off: the verified failing test becomes a draft pull request, built by trusted code
      //    from exactly what it verified. A person or another agent writes the fix.
      let handOffNote = "";
      const sha256 = verification?.testSha256;
      if (verdict.verified && verification && sha256 && testSource && baseSha && github.canWrite) {
        const handOff = {
          repo: issue.repo,
          baseBranch: issue.defaultBranch,
          issueNumber: issue.issueNumber,
          runId,
          baseSha,
          test: { path: verification.testFile ?? "", content: testSource, sha256 },
          verification,
          outcome,
        };
        try {
          const opened = await step.do("open pull request", QUICK, () =>
            openTestPullRequest(github, handOff),
          );
          pullRequest = opened;
          log(runId, opened.url ? "pr.opened" : "pr.skipped", { ...opened });
          handOffNote = opened.url
            ? `**Draft pull request with the failing test, ready for a fix:** ${opened.url}\n\n`
            : `**No pull request:** ${opened.reason}.\n\n`;
        } catch (error) {
          log(runId, "pr.failed", { error: describe(error) });
          handOffNote = `**No pull request:** ${describe(error)}.\n\n`;
        }
      }

      const report = renderReport(context, outcome, new Date().toISOString(), verified);
      await comment(
        "outcome",
        `${handOffNote}${report}\n---\n_Written by an AI agent and checked by the triage harness on commit \`${baseSha?.slice(0, 7)}\`._`,
      );
    } else {
      await comment("outcome", `Triage could not finish: ${result.failure ?? "unknown error"}.`);
    }

    // 5. The run is over: free the container now, not when its 30-minute lifetime fires.
    try {
      await step.do("destroy sandbox", QUICK, () => sandbox.destroy());
      log(runId, "sandbox.destroyed");
    } catch (error) {
      log(runId, "sandbox.destroy_failed", { error: describe(error) });
    }

    const summary = {
      baseSha,
      claimed: outcome?.outcome ?? null,
      outcome: verdict?.outcome ?? null,
      verified: verdict?.verified ?? false,
      failure: result.failure,
      pullRequest: pullRequest?.url ?? null,
    };
    log(runId, "run.finished", summary);
    return summary;
  }
}
