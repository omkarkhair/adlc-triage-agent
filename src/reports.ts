export const REPORT_MAX_CHARS = 20_000;

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

export function renderReport(context: ReportContext, body: string, savedAt: string): string {
  return [
    `# Triage report: ${context.repo}#${context.issueNumber}`,
    "",
    `- Agent: \`${context.agentId}\``,
    `- Saved: ${savedAt}`,
    "",
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

export async function saveReport(
  bucket: ReportBucket,
  context: ReportContext,
  body: string,
  now: Date = new Date(),
): Promise<string> {
  const key = reportKey(context.agentId);
  await bucket.put(key, renderReport(context, body, now.toISOString()), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: {
      agentId: context.agentId,
      repo: context.repo,
      issue: String(context.issueNumber),
    },
  });
  return key;
}
