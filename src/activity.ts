import { type FlueEvent, observe } from "@flue/runtime";

export type ActivityRecord = Record<string, string | number | boolean | string[] | null>;

/**
 * Turns one Flue runtime event into a log record, or null for events we don't log. One line per
 * attempt, model turn and tool call is enough to see where a run is (or where it stalled)
 * from `wrangler tail`, without opening Traces.
 */
export function activityRecord(event: FlueEvent): ActivityRecord | null {
  const agentId = event.instanceId ?? null;
  switch (event.type) {
    case "submission_running":
      return {
        event: "agent.attempt",
        agentId,
        attempt: event.attemptCount,
        maxAttempts: event.maxAttempts,
      };
    case "turn_start":
      return { event: "turn.started", agentId, turnId: event.turnId };
    case "turn": {
      const toolCalls = (event.response.output?.content ?? []).flatMap((part) =>
        part.type === "toolCall" ? [part.name] : [],
      );
      return {
        event: "turn.finished",
        agentId,
        turnId: event.turnId,
        durationMs: event.durationMs,
        finishReason: event.response.finishReason ?? null,
        toolCalls,
        outputTokens: event.response.usage?.output ?? null,
        isError: event.isError,
        error: event.response.error?.message?.slice(0, 300) ?? null,
      };
    }
    case "tool":
      return {
        event: "tool.finished",
        agentId,
        tool: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs,
      };
    default:
      return null;
  }
}

let subscribed = false;

/** Logs agent activity as JSON lines. Call once at module scope in `app.ts`. */
export function logAgentActivity(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  observe((event) => {
    const record = activityRecord(event);
    if (record) {
      console.log(JSON.stringify(record));
    }
  });
}
