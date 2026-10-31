import type { ReproOutcome } from "./outcome";

export interface ReportBucket {
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export interface ReportContext {
  agentId: string;
  repo: string;
  issueNumber: number;
}

export function reportKey(agentId: string): string {
  return `runs/${agentId}/report.md`;
}

export function renderReport(
  context: ReportContext,
  outcome: ReproOutcome,
  savedAt: string,
): string {
  const section = (title: string, value: string | undefined) =>
    value?.trim() ? ["", `## ${title}`, "", value.trim()] : [];
  return [
    `# Triage report: ${context.repo}#${context.issueNumber}`,
    "",
    `- Agent: \`${context.agentId}\``,
    `- Saved: ${savedAt}`,
    "",
    `**Outcome:** \`${outcome.outcome}\``,
    ...section("Summary", outcome.summary),
    ...section("Expected", outcome.expected),
    ...section("Observed", outcome.observed),
    ...section("Test file", outcome.testFile && `\`${outcome.testFile}\``),
    ...section("Missing information", outcome.missingInformation),
    ...section("Hypothesis (unverified)", outcome.hypothesis),
    "",
  ].join("\n");
}

export async function saveReport(
  bucket: ReportBucket,
  context: ReportContext,
  outcome: ReproOutcome,
  now: Date = new Date(),
): Promise<string> {
  const key = reportKey(context.agentId);
  await bucket.put(key, renderReport(context, outcome, now.toISOString()), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: {
      agentId: context.agentId,
      repo: context.repo,
      issue: String(context.issueNumber),
      outcome: outcome.outcome,
    },
  });
  return key;
}
