import { type Candidate, candidateKeys, classifyChange } from "./candidate";
import type { GitHubClient, PullRequest } from "./github/client";
import { clean, isAllowedTestPath, sha256Hex } from "./verify";

/** The part of an R2 bucket binding this module uses. */
export interface CandidateSource {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface PullRequestResult {
  action: "created" | "exists" | "skipped";
  branch: string;
  reason: string;
  number: number | null;
  url: string | null;
}

export interface PullRequestInput {
  repo: string;
  baseBranch: string;
  issueNumber: number;
  runId: string;
  candidate: Candidate;
  proposal: { summary: string; rationale: string } | null;
}

/** The branch a run's pull request comes from. One per issue, like the run itself. */
export function pullRequestBranch(issueNumber: number): string {
  return `triage/issue-${issueNumber}`;
}

/**
 * Reads the candidate back from R2 and checks that it is the one that was verified: status
 * `verified`, the expected digest, a patch that still hashes to it, and only files a fix may
 * touch. The pull request is built from this record, never from what an agent says.
 */
export async function loadVerifiedCandidate(
  bucket: CandidateSource,
  runId: string,
  digest: string,
): Promise<Candidate> {
  const key = candidateKeys(runId).record;
  const object = await bucket.get(key);
  if (!object) {
    throw new Error(`No candidate in R2 at ${key}`);
  }
  const candidate = JSON.parse(await object.text()) as Candidate;
  if (candidate.status !== "verified") {
    throw new Error("The stored candidate is not verified");
  }
  if (candidate.digest !== digest || (await sha256Hex(candidate.patch)) !== digest) {
    throw new Error("The stored candidate does not match the verified digest");
  }
  for (const file of candidate.files) {
    const isTest = file.path === candidate.testFile && isAllowedTestPath(file.path);
    if (!isTest && classifyChange({ status: "??", path: file.path }, "") !== "apply") {
      throw new Error(
        `The candidate touches a file a fix may not change: ${clean(file.path, 200)}`,
      );
    }
  }
  return candidate;
}

export function renderPullRequest(input: PullRequestInput): { title: string; body: string } {
  const { candidate, issueNumber, runId, proposal } = input;
  const keys = candidateKeys(runId);
  const lines = [
    `Refs #${issueNumber}`,
    "",
    "> [!WARNING]",
    "> Written by an AI agent and checked by the triage harness. **Not reviewed by a person.**",
    "> Read the whole diff before you mark this ready or merge it.",
    "",
  ];
  if (proposal) {
    lines.push("## What the agent changed", "", proposal.summary.trim(), "");
    lines.push("## Why (the agent's reasoning, not verified)", "", proposal.rationale.trim(), "");
  }
  lines.push(
    "## What the harness checked",
    "",
    `In a fresh sandbox, on base commit \`${candidate.baseSha}\`:`,
    "",
    `- the unchanged regression test \`${candidate.testFile}\` failed without the fix`,
    "- the same test passed with the fix",
  );
  for (const check of candidate.checks) {
    lines.push(`- \`${check.command}\` passed`);
  }
  lines.push(
    "",
    "## Evidence",
    "",
    `- Candidate digest: \`sha256:${candidate.digest}\` (SHA-256 of the patch)`,
    `- Report: \`runs/${runId}/report.md\` in the reports bucket`,
    `- Patch: \`${keys.patch}\`, record: \`${keys.record}\``,
    `- Regression test SHA-256: \`${candidate.testSha256}\``,
  );
  return {
    title: `Candidate fix for #${issueNumber} (agent-written, unreviewed)`,
    body: lines.join("\n"),
  };
}

function commitMessage(input: PullRequestInput): string {
  return [
    `Candidate fix for #${input.issueNumber}`,
    "",
    "Written by the ADLC triage agent and checked by its harness. Not reviewed by a person.",
    "",
    `Candidate: sha256:${input.candidate.digest}`,
    `Base: ${input.candidate.baseSha}`,
  ].join("\n");
}

/**
 * Opens a draft pull request for a verified candidate. The Worker builds the commit through
 * GitHub's Git Data API from the stored files, so the token never enters a sandbox. Safe to
 * retry: an existing pull request is reported, and an existing branch is reused only if it
 * holds exactly these files on this base commit. It never merges and never force-pushes.
 */
export async function openDraftPullRequest(
  github: GitHubClient,
  input: PullRequestInput,
): Promise<PullRequestResult> {
  const { repo, candidate } = input;
  const branch = pullRequestBranch(input.issueNumber);
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

  const baseTree = await github.commitTree(repo, candidate.baseSha);
  const tree = await github.createTree(repo, baseTree, candidate.files);
  const head = await github.branchHead(repo, branch);
  if (head === null) {
    const commit = await github.createCommit(repo, commitMessage(input), tree, candidate.baseSha);
    await github.createBranch(repo, branch, commit);
  } else if ((await github.commitTree(repo, head)) !== tree) {
    return result("skipped", `branch ${branch} already exists with other changes`);
  }

  const pull = await github.createDraftPullRequest(repo, {
    ...renderPullRequest(input),
    head: branch,
    base: input.baseBranch,
  });
  return result("created", "opened a draft pull request", pull);
}
