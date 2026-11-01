import type { ReproOutcome } from "./outcome";
import type { Verdict, Verification } from "./verify";

/** What the harness found when it re-ran the agent's test (checkpoint 4). */
export interface VerifiedReport {
  verdict: Verdict;
  verification: Verification | null;
  testSource: string | null;
}

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
  verified?: VerifiedReport,
): string {
  const section = (title: string, value: string | undefined) =>
    value?.trim() ? ["", `## ${title}`, "", value.trim()] : [];
  const final = verified?.verdict.outcome ?? outcome.outcome;
  const claimed = final === outcome.outcome ? "" : ` (the agent claimed \`${outcome.outcome}\`)`;
  return [
    `# Triage report: ${context.repo}#${context.issueNumber}`,
    "",
    `- Agent: \`${context.agentId}\``,
    `- Saved: ${savedAt}`,
    "",
    `**Outcome:** \`${final}\`${claimed}`,
    ...section("Summary", outcome.summary),
    ...section("Expected", outcome.expected),
    ...section("Observed", outcome.observed),
    ...section("Test file", outcome.testFile && `\`${outcome.testFile}\``),
    ...section("Missing information", outcome.missingInformation),
    ...section("Hypothesis (unverified)", outcome.hypothesis),
    ...(verified ? verificationSection(verified) : []),
    "",
  ].join("\n");
}

function verificationSection({ verdict, verification, testSource }: VerifiedReport): string[] {
  const lines = ["", "## Verification", "", verdict.note];
  if (verification) {
    lines.push(
      "",
      `- Result: \`${verification.status}\` (${verification.reason})`,
      `- Tests: ${verification.failed} failed, ${verification.passed} passed`,
    );
    if (verification.testSha256) {
      lines.push(`- Test file SHA-256: \`${verification.testSha256}\``);
    }
    for (const failure of verification.failures) {
      lines.push("", `**${failure.name}**`, "", fenced(failure.message, "text"));
    }
  }
  if (testSource) {
    lines.push(
      "",
      `### Test file \`${verification?.testFile ?? ""}\``,
      "",
      fenced(testSource, "ts"),
    );
  }
  return lines;
}

/** A code block whose fence is longer than any backtick run inside the text. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.trimEnd()}\n${fence}`;
}

export async function saveReport(
  bucket: ReportBucket,
  context: ReportContext,
  outcome: ReproOutcome,
  now: Date = new Date(),
  verified?: VerifiedReport,
): Promise<string> {
  const key = reportKey(context.agentId);
  await bucket.put(key, renderReport(context, outcome, now.toISOString(), verified), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: {
      agentId: context.agentId,
      repo: context.repo,
      issue: String(context.issueNumber),
      outcome: verified?.verdict.outcome ?? outcome.outcome,
      verified: String(verified?.verdict.verified ?? false),
    },
  });
  return key;
}
