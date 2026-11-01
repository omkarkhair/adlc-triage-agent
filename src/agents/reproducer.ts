"use agent";
import { env } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  type AgentProps,
  useInitialData,
  useModel,
  useResponseFinish,
  useSandbox,
  useTool,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import { modelFor } from "../models";
import { REPORT_MAX_CHARS, saveReport } from "../reports";
import procedure from "./reproducer.md";

export const WORKSPACE = "/workspace";

export interface ReproducerData {
  repo: string;
  issueNumber: number;
}

export function Reproducer({ id }: AgentProps) {
  const model = modelFor(env);
  useModel(model, { thinkingLevel: "low" });

  const sandboxes = env.Sandbox as DurableObjectNamespace<Sandbox>;
  useSandbox(cloudflareSandbox(getSandbox(sandboxes, id)), { cwd: WORKSPACE });

  const data = useInitialData<ReproducerData>();

  useTool({
    name: "save_report",
    description:
      "Save your final triage report (Markdown) and end the run. Call exactly once, last.",
    input: v.object({ report: v.pipe(v.string(), v.minLength(1), v.maxLength(REPORT_MAX_CHARS)) }),
    async run({ data: input }) {
      const context = { agentId: id, repo: data.repo, issueNumber: data.issueNumber };
      const key = await saveReport(env.REPORTS, context, input.report);
      console.log(JSON.stringify({ event: "report.saved", agentId: id, key }));
      return { output: `Report saved as ${key}.`, terminate: true };
    },
  });

  useResponseFinish(({ response }) => {
    console.log(
      JSON.stringify({
        event: "agent.finished",
        agentId: id,
        issue: data.issueNumber,
        model,
        reportSaved: response.toolCalls.some((c) => c.tool === "save_report" && !c.isError),
        toolCalls: response.toolCalls.length,
        totalTokens: response.usage.totalTokens,
      }),
    );
  });

  const context = [
    "# Run context",
    "",
    `- Repository: https://github.com/${data.repo}.git`,
    `- Issue number: ${data.issueNumber}`,
    `- Working directory: ${WORKSPACE}`,
  ].join("\n");

  return `${procedure}\n${context}\n`;
}

// Flue runs all attempts inside one Durable Object alarm, which may last at most 15 minutes,
// so maxAttempts × timeoutMs must stay below that.
Reproducer.durability = { maxAttempts: 2, timeoutMs: 7 * 60_000 };
