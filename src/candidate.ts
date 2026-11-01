import {
  clean,
  type FileSandbox,
  runTest,
  runTestOnBase,
  sha256Hex,
  type TestFile,
  type Verification,
} from "./verify";
import { strictScript, WORKSPACE_DIR } from "./workspace";

/** The part of an R2 bucket binding this module uses. */
export interface CandidateBucket {
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export const MAX_FIX_FILES = 10;
export const MAX_FIX_CHARS = 200_000;
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const OUTPUT_TAIL = 2_000;

/** The project's own checks, run in this order on the patched code. */
export const CHECKS = [
  { name: "lint", command: "pnpm lint" },
  { name: "typecheck", command: "pnpm typecheck" },
  { name: "test", command: "pnpm test" },
  { name: "build", command: "pnpm build" },
] as const;

/** One file of the fix. `content: null` means the fix deletes it. */
export interface ChangedFile {
  path: string;
  content: string | null;
}

export interface FixChanges {
  files: ChangedFile[];
  ignored: string[];
}

export interface CheckResult {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface Candidate {
  status: "verified" | "failed";
  reason: string;
  baseSha: string;
  testFile: string;
  testSha256: string;
  /** The regression test on the base commit, in a fresh sandbox: must be red. */
  red: Verification | null;
  /** The same, unchanged test with the fix applied: must be green. */
  green: Verification | null;
  checks: CheckResult[];
  /** Everything a pull request would contain: the fix plus the regression test. */
  files: ChangedFile[];
  ignored: string[];
  patch: string;
  /** sha256 of `patch`: names this exact candidate. */
  digest: string | null;
}

interface StatusEntry {
  status: string;
  path: string;
}

export function parseStatus(output: string): StatusEntry[] {
  return output
    .split("\n")
    .filter((line) => line.length > 3)
    .flatMap((line) => {
      const status = line.slice(0, 2);
      const path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) {
        return [
          { status: " D", path: path.slice(0, arrow) },
          { status: "??", path: path.slice(arrow + 4) },
        ];
      }
      return [{ status, path }];
    });
}

/**
 * Which changed files the fix may contain. Production code under `src/` and brand-new migrations
 * (the demo app's practices put schema changes in a new migration). Everything else is ignored,
 * including any edit to a test: the original regression test is put back instead.
 */
export function classifyChange(
  entry: StatusEntry,
  testPath: string,
): "apply" | "regression-test" | string {
  const { status, path } = entry;
  if (path === testPath) {
    return "regression-test";
  }
  if (!SAFE_PATH.test(path) || path.split("/").includes("..")) {
    return "unsupported file name";
  }
  if (path.startsWith("src/")) {
    return "apply";
  }
  if (path.startsWith("migrations/")) {
    return status === "??" || status.startsWith("A")
      ? "apply"
      : "an existing migration must not be edited";
  }
  return "only src/ and new migrations/ files are applied";
}

/** Reads the fixer's changes out of its sandbox. Trusted code decides what counts. */
export async function collectChanges(sandbox: FileSandbox, testPath: string): Promise<FixChanges> {
  const status = await sandbox.exec(
    "git -c core.quotePath=true status --porcelain=v1 --untracked-files=all",
    { cwd: WORKSPACE_DIR, timeout: 30_000 },
  );
  if (status.exitCode !== 0) {
    throw new Error(`Could not list the fixer's changes: ${clean(status.stderr, 300)}`);
  }
  const files: ChangedFile[] = [];
  const ignored: string[] = [];
  let chars = 0;
  for (const entry of parseStatus(status.stdout)) {
    const verdict = classifyChange(entry, testPath);
    if (verdict === "regression-test") {
      continue;
    }
    if (verdict !== "apply") {
      ignored.push(`${entry.path} (${verdict})`);
      continue;
    }
    if (entry.status.includes("D")) {
      files.push({ path: entry.path, content: null });
      continue;
    }
    const { content } = await sandbox.readFile(`${WORKSPACE_DIR}/${entry.path}`, {
      encoding: "utf-8",
    });
    chars += content.length;
    files.push({ path: entry.path, content });
  }
  if (files.length > MAX_FIX_FILES) {
    throw new Error(`The fix changes ${files.length} files; at most ${MAX_FIX_FILES} are allowed`);
  }
  if (chars > MAX_FIX_CHARS) {
    throw new Error(`The fix is larger than ${MAX_FIX_CHARS} characters`);
  }
  return { files, ignored };
}

async function writeFiles(sandbox: FileSandbox, files: ChangedFile[]): Promise<void> {
  for (const file of files) {
    const target = `${WORKSPACE_DIR}/${file.path}`;
    if (file.content === null) {
      await sandbox.exec(`rm -f -- '${target}'`);
      continue;
    }
    await sandbox.exec(`mkdir -p -- '${target.slice(0, target.lastIndexOf("/"))}'`);
    await sandbox.writeFile(target, file.content, { encoding: "utf-8" });
  }
}

async function runCheck(sandbox: FileSandbox, name: string, command: string) {
  const started = Date.now();
  // Variables set in front of a command apply to that command only, so nothing leaks into
  // the shared shell session.
  const env = "CI=1 NO_COLOR=1 FORCE_COLOR=0 WRANGLER_SEND_METRICS=false";
  try {
    const run = await sandbox.exec(`${env} ${command}`, { cwd: WORKSPACE_DIR, timeout: 300_000 });
    const output = clean([run.stdout, run.stderr].join("\n"), 1_000_000).slice(-OUTPUT_TAIL);
    return { name, command, exitCode: run.exitCode, durationMs: Date.now() - started, output };
  } catch (error) {
    const output = error instanceof Error ? clean(error.message, OUTPUT_TAIL) : "did not finish";
    return { name, command, exitCode: 124, durationMs: Date.now() - started, output };
  }
}

/**
 * Checks a fix in a sandbox that only trusted code has used: a fresh checkout of the base
 * commit. The unchanged regression test must fail first (red), then pass with the fix (green),
 * and then the project's lint, typecheck, test and build must pass. Only then is the fix a
 * candidate, named by the sha256 of its patch. Safe to retry: it starts with a reset.
 */
export async function verifyCandidate(
  sandbox: FileSandbox,
  baseSha: string,
  test: TestFile,
  changes: FixChanges,
): Promise<Candidate> {
  const testFile: ChangedFile = { path: test.path, content: test.content };
  const base = {
    baseSha,
    testFile: test.path,
    testSha256: test.sha256,
    files: [...changes.files, testFile],
    ignored: changes.ignored,
    red: null,
    green: null,
    checks: [],
    patch: "",
    digest: null,
  };
  if (changes.files.length === 0) {
    return {
      ...base,
      status: "failed",
      reason: "the fix changes no file under src/ or migrations/",
    };
  }

  const red = await runTestOnBase(sandbox, baseSha, test);
  if (red.status !== "red") {
    return {
      ...base,
      red,
      status: "failed",
      reason: `the regression test was not red on a fresh checkout (${red.reason})`,
    };
  }

  await writeFiles(sandbox, changes.files);
  const green = await runTest(sandbox, test);
  if (green.status !== "green") {
    return {
      ...base,
      red,
      green,
      status: "failed",
      reason: `the unchanged regression test does not pass with the fix (${green.reason})`,
    };
  }

  const paths = base.files.map((file) => `'${file.path}'`).join(" ");
  const diff = await sandbox.exec(
    strictScript([`git add -A -- ${paths}`, "git diff --cached --no-color --no-ext-diff"]),
    { cwd: WORKSPACE_DIR, timeout: 60_000 },
  );
  if (diff.exitCode !== 0) {
    throw new Error(`Could not build the patch: ${clean(diff.stderr, 300)}`);
  }
  const patch = diff.stdout;

  const checks: CheckResult[] = [];
  for (const check of CHECKS) {
    checks.push(await runCheck(sandbox, check.name, check.command));
  }
  const failed = checks.filter((check) => check.exitCode !== 0).map((check) => check.name);
  const digest = await sha256Hex(patch);
  if (failed.length > 0) {
    return {
      ...base,
      red,
      green,
      checks,
      patch,
      digest,
      status: "failed",
      reason: `checks failed: ${failed.join(", ")}`,
    };
  }
  return {
    ...base,
    red,
    green,
    checks,
    patch,
    digest,
    status: "verified",
    reason: "the regression test went from red to green and every check passed",
  };
}

export function candidateKeys(runId: string) {
  return { patch: `runs/${runId}/candidate.patch`, record: `runs/${runId}/candidate.json` };
}

/** Stores the patch and the full candidate record (including file contents) in R2. */
export async function saveCandidate(
  bucket: CandidateBucket,
  runId: string,
  candidate: Candidate,
): Promise<{ patch: string; record: string }> {
  const keys = candidateKeys(runId);
  const customMetadata = { status: candidate.status, digest: candidate.digest ?? "" };
  await bucket.put(keys.patch, candidate.patch, {
    httpMetadata: { contentType: "text/x-diff; charset=utf-8" },
    customMetadata,
  });
  await bucket.put(keys.record, JSON.stringify(candidate, null, 2), {
    httpMetadata: { contentType: "application/json" },
    customMetadata,
  });
  return keys;
}

function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.trimEnd()}\n${fence}`;
}

function shorten(text: string, max: number, note: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${note})`;
}

/** The issue comment for a fix candidate. Keeps well under GitHub's 65,536-character limit. */
export function renderCandidate(
  runId: string,
  candidate: Candidate,
  proposal: { summary: string; rationale: string } | null,
): string {
  const keys = candidateKeys(runId);
  const lines = [
    "# Fix candidate",
    "",
    `**Result:** \`${candidate.status}\`: ${candidate.reason}.`,
  ];
  if (proposal) {
    lines.push("", "## What the agent changed", "", proposal.summary.trim());
    lines.push("", "## Why (the agent's reasoning, not verified)", "", proposal.rationale.trim());
  }
  lines.push(
    "",
    "## Checks run by the harness",
    "",
    "| Check | Result | Time |",
    "| --- | --- | --- |",
  );
  const row = (name: string, ok: boolean, detail: string) =>
    lines.push(`| ${name} | ${ok ? "pass" : "fail"} | ${detail} |`);
  if (candidate.red) {
    row("regression test on the base commit is red", candidate.red.status === "red", "-");
  }
  if (candidate.green) {
    row("regression test with the fix is green", candidate.green.status === "green", "-");
  }
  for (const check of candidate.checks) {
    row(`\`${check.command}\``, check.exitCode === 0, `${Math.round(check.durationMs / 1000)}s`);
  }
  for (const check of candidate.checks.filter((c) => c.exitCode !== 0)) {
    lines.push("", `<details><summary>${check.name} output</summary>`, "");
    lines.push(fenced(shorten(check.output, 1_500, "shortened"), "text"), "", "</details>");
  }
  lines.push("", "## Files", "");
  for (const file of candidate.files) {
    const kind = file.path === candidate.testFile ? "regression test" : "fix";
    lines.push(`- \`${file.path}\` (${file.content === null ? "deleted" : kind})`);
  }
  for (const ignored of candidate.ignored) {
    lines.push(`- ignored: \`${ignored}\``);
  }
  if (candidate.digest) {
    lines.push("", `Candidate digest: \`sha256:${candidate.digest}\``);
    lines.push("", "<details><summary>candidate.patch</summary>", "");
    lines.push(
      fenced(
        shorten(candidate.patch, 30_000, `shortened; full patch in R2 at ${keys.patch}`),
        "diff",
      ),
    );
    lines.push("", "</details>");
  }
  return lines.join("\n");
}
