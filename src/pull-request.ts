import type { GitHubClient, PullRequest } from "./github/client";
import { clean, isAllowedTestPath, sha256Hex, type TestFile, type Verification } from "./verify";

export interface PullRequestResult {
  action: "created" | "exists" | "skipped";
  branch: string;
  reason: string;
  number: number | null;
  url: string | null;
}

export interface HandOff {
  repo: string;
  baseBranch: string;
  issueNumber: number;
  runId: string;
  baseSha: string;
  /** The agent's test, as collected before the workspace was reset. */
  test: TestFile;
  /** The trusted re-run of that test on the base commit. */
  verification: Verification;
  /** What the agent reported. Shown as its claim, not as fact. */
  outcome: { summary: string; expected: string; observed: string };
}

/** The branch a run's pull request comes from. One per issue, like the run itself. */
export function pullRequestBranch(issueNumber: number): string {
  return `triage/issue-${issueNumber}`;
}

/**
 * Only a test the harness saw fail goes into a pull request: the trusted re-run must be red, and
 * it must have run exactly these bytes. The pull request holds nothing else.
 */
export async function checkHandOff(handOff: HandOff): Promise<void> {
  const { test, verification } = handOff;
  if (verification.status !== "red") {
    throw new Error("Only a verified failing test can be handed off");
  }
  if (!isAllowedTestPath(test.path) || verification.testFile !== test.path) {
    throw new Error(`Unexpected test file: ${clean(test.path, 200)}`);
  }
  const sha256 = await sha256Hex(test.content);
  if (sha256 !== test.sha256 || verification.testSha256 !== sha256) {
    throw new Error("The test file does not match the one that was verified");
  }
}

function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.trimEnd()}\n${fence}`;
}

export function renderTestPullRequest(handOff: HandOff): { title: string; body: string } {
  const { issueNumber, runId, baseSha, test, verification, outcome } = handOff;
  const lines = [
    `Refs #${issueNumber}`,
    "",
    "> [!WARNING]",
    "> Written by an AI agent and checked by the triage harness. **Not reviewed by a person.**",
    "> This pull request adds a failing test and no fix. CI stays red until the bug is fixed.",
    "",
    "## The failing test",
    "",
    `\`${test.path}\` reproduces the issue. The harness ran it on a clean checkout of`,
    `\`${baseSha}\` and it failed on an assertion (${verification.failed} failed,`,
    `${verification.passed} passed).`,
    "",
  ];
  for (const failure of verification.failures.slice(0, 3)) {
    lines.push(`**${failure.name}**`, "", fenced(failure.message, "text"), "");
  }
  lines.push(
    "## What the agent reported (not verified)",
    "",
    clean(outcome.summary, 2_000),
    "",
    `- **Expected:** ${clean(outcome.expected, 2_000)}`,
    `- **Observed:** ${clean(outcome.observed, 2_000)}`,
    "",
    "## To fix it",
    "",
    "Push commits to this branch (a person or a coding agent) that:",
    "",
    "- make this test pass **without changing it**,",
    "- change only `src/`, plus a new file under `migrations/` if the schema must change,",
    "- keep `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` passing.",
    "",
    "## Evidence",
    "",
    `- Base commit: \`${baseSha}\``,
    `- Test SHA-256: \`${test.sha256}\``,
    `- Report: \`runs/${runId}/report.md\` in the reports bucket`,
  );
  return {
    title: `Failing test for #${issueNumber} (agent-written, unreviewed)`,
    body: lines.join("\n"),
  };
}

function commitMessage(handOff: HandOff): string {
  return [
    `Add a failing test for #${handOff.issueNumber}`,
    "",
    "Written by the ADLC triage agent and verified red by its harness. Not reviewed by a person.",
    "",
    `Test: ${handOff.test.path} (sha256:${handOff.test.sha256})`,
    `Base: ${handOff.baseSha}`,
  ].join("\n");
}

/**
 * Opens a draft pull request that adds only the verified failing test, on top of the base
 * commit. The Worker builds the commit through GitHub's Git Data API, so the token never enters
 * a sandbox. Safe to retry: an existing pull request is reported, and an existing branch is
 * reused only if it holds exactly this test on this base commit. It never merges, never
 * force-pushes, and never touches a branch with other changes.
 */
export async function openTestPullRequest(
  github: GitHubClient,
  handOff: HandOff,
): Promise<PullRequestResult> {
  await checkHandOff(handOff);
  const { repo, baseSha, test } = handOff;
  const branch = pullRequestBranch(handOff.issueNumber);
  const result = (
    action: PullRequestResult["action"],
    reason: string,
    pull: PullRequest | null = null,
  ): PullRequestResult => ({
    action,
    branch,
    reason,
    number: pull?.number ?? null,
    url: pull?.url ?? null,
  });

  const existing = await github.findPullRequest(repo, branch);
  if (existing) {
    return result("exists", "a pull request from this branch already exists", existing);
  }

  const baseTree = await github.commitTree(repo, baseSha);
  const tree = await github.createTree(repo, baseTree, [
    { path: test.path, content: test.content },
  ]);
  const head = await github.branchHead(repo, branch);
  if (head === null) {
    const commit = await github.createCommit(repo, commitMessage(handOff), tree, baseSha);
    await github.createBranch(repo, branch, commit);
  } else if ((await github.commitTree(repo, head)) !== tree) {
    return result("skipped", `branch ${branch} already exists with other changes`);
  }

  const pull = await github.createDraftPullRequest(repo, {
    ...renderTestPullRequest(handOff),
    head: branch,
    base: handOff.baseBranch,
  });
  return result("created", "opened a draft pull request", pull);
}
