"use agent";
import { env } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  type AgentProps,
  useAgentFinish,
  useInitialData,
  useModel,
  usePersistentState,
  useResponseFinish,
  useSandbox,
  useTool,
} from "@flue/runtime";
import { cloudflareSandbox } from "@flue/runtime/cloudflare";
import { modelFor } from "../models";
import { checkOutcome, ReproOutcome } from "../outcome";
import { saveReport } from "../reports";
import procedure from "./reproducer.md";

export const WORKSPACE = "/workspace";
export const MAX_REMINDERS = 2;

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
  const [reminders, setReminders] = usePersistentState("reminders", 0);

  useTool({
    name: "submit_outcome",
    description: "Record your final reproduction outcome and end the run. Call exactly once, last.",
    input: ReproOutcome,
    async run({ data: outcome }) {
      const problem = checkOutcome(outcome);
      if (problem) {
        throw new Error(problem);
      }
      const context = { agentId: id, repo: data.repo, issueNumber: data.issueNumber };
      const key = await saveReport(env.REPORTS, context, outcome);
      setReminders(0);
      console.log(
        JSON.stringify({ event: "outcome.submitted", agentId: id, outcome: outcome.outcome, key }),
      );
      return { output: `Outcome recorded as ${key}.`, terminate: true };
    },
  });

  useAgentFinish(({ response, append }) => {
    const submitted = response.toolCalls.some((c) => c.tool === "submit_outcome" && !c.isError);
    if (submitted || reminders >= MAX_REMINDERS) {
      return;
    }
    setReminders(reminders + 1);
    console.log(JSON.stringify({ event: "agent.reminded", agentId: id, reminder: reminders + 1 }));
    append({
      kind: "signal",
      type: "triage.reminder",
      body: "You stopped without a successful submit_outcome call. Call submit_outcome now with the best supported outcome. Use cannot-reproduce if you have no failing test.",
    });
  });

  useResponseFinish(({ response }) => {
    console.log(
      JSON.stringify({
        event: "agent.finished",
        agentId: id,
        issue: data.issueNumber,
        model,
        outcomeSubmitted: response.toolCalls.some((c) => c.tool === "submit_outcome" && !c.isError),
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

// timeoutMs is one deadline for the whole run, all attempts included. Flue runs them inside one
// Durable Object alarm (at most 15 minutes) and checks the deadline between model turns, so it
// leaves room for a turn that is still running when the deadline passes.
Reproducer.durability = { maxAttempts: 2, timeoutMs: 10 * 60_000 };
