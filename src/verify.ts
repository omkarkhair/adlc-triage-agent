import { type ExecLike, strictScript, WORKSPACE_DIR } from "./workspace";

export type Outcome = "reproduced" | "cannot-reproduce" | "needs-information";

export const MAX_TEST_CHARS = 20_000;
const TEST_PATH = /^tests\/[A-Za-z0-9._/-]+\.test\.ts$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RESULT_FILE = "/tmp/adlc-verify.json";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** A sandbox that can also read and write files (the Cloudflare Sandbox can). */
export interface FileSandbox extends ExecLike {
  readFile(path: string, options?: { encoding?: string }): Promise<{ content: string }>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
}

export interface TestFile {
  path: string;
  content: string;
  sha256: string;
}

export interface Verification {
  /** red: an assertion failed. green: every test passed. invalid: the run proved nothing. */
  status: "red" | "green" | "invalid";
  reason: string;
  testFile: string | null;
  testSha256: string | null;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
}

export interface Verdict {
  outcome: Outcome;
  claimed: Outcome;
  verified: boolean;
  note: string;
}

export function isAllowedTestPath(path: string): boolean {
  return TEST_PATH.test(path) && !path.split("/").includes("..");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function clean(text: string, max: number): string {
  return text.replace(ANSI, "").trim().slice(0, max);
}

/** Reads the agent's test out of the sandbox before anything resets it. */
export async function collectTestFile(sandbox: FileSandbox, path: string): Promise<TestFile> {
  if (!isAllowedTestPath(path)) {
    throw new Error(
      `The test file must be under tests/ and end in .test.ts; got ${clean(path, 200)}`,
    );
  }
  const { content } = await sandbox.readFile(`${WORKSPACE_DIR}/${path}`, { encoding: "utf-8" });
  if (content.length > MAX_TEST_CHARS) {
    throw new Error(`${path} is longer than ${MAX_TEST_CHARS} characters`);
  }
  return { path, content, sha256: await sha256Hex(content) };
}

interface VitestJson {
  numFailedTests?: number;
  numPassedTests?: number;
  testResults?: {
    status?: string;
    message?: string;
    assertionResults?: {
      fullName?: string;
      title?: string;
      status?: string;
      failureMessages?: string[];
    }[];
  }[];
}

/**
 * Decides what one vitest JSON report proves. Only an assertion failure counts as red: a test
 * that crashes (bad import, typo, TypeError) or fails to load proves nothing about the bug.
 */
export function interpretVitest(
  raw: string,
  exitCode: number,
  test: Pick<TestFile, "path" | "sha256">,
): Verification {
  const base = { testFile: test.path, testSha256: test.sha256, passed: 0, failed: 0, failures: [] };
  let report: VitestJson;
  try {
    report = JSON.parse(raw) as VitestJson;
  } catch {
    return { ...base, status: "invalid", reason: "vitest did not write a JSON report" };
  }
  const suites = report.testResults ?? [];
  const failures = suites.flatMap((suite) =>
    (suite.assertionResults ?? [])
      .filter((result) => result.status === "failed")
      .map((result) => ({
        name: clean(result.fullName || result.title || "unnamed test", 200),
        message: clean((result.failureMessages ?? []).join("\n"), 1_000),
      })),
  );
  const counts = {
    ...base,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? failures.length,
    failures: failures.slice(0, 5),
  };
  const loadError = suites.find(
    (suite) => suite.status === "failed" && (suite.assertionResults ?? []).length === 0,
  );
  if (suites.length === 0) {
    return { ...counts, status: "invalid", reason: "vitest found no test file to run" };
  }
  if (loadError) {
    return {
      ...counts,
      status: "invalid",
      reason: `the test file failed to load: ${clean(loadError.message || "no message", 300)}`,
    };
  }
  if (counts.failed > 0 && exitCode !== 0) {
    if (failures.some((failure) => failure.message.startsWith("AssertionError"))) {
      return {
        ...counts,
        status: "red",
        reason: `${counts.failed} test(s) failed on an assertion`,
      };
    }
    return {
      ...counts,
      status: "invalid",
      reason: "the test failed with an error, not a failed assertion",
    };
  }
  if (counts.failed === 0 && counts.passed > 0 && exitCode === 0) {
    return { ...counts, status: "green", reason: "every test passed" };
  }
  return { ...counts, status: "invalid", reason: `inconclusive test run (exit code ${exitCode})` };
}

/**
 * Trusted re-run of the agent's test. Resets the workspace to the pinned commit (undoing
 * anything the agent changed), writes back only the test file, and runs it with vitest's JSON
 * reporter. Safe to retry: every run starts from the same reset.
 */
export async function runTestOnBase(
  sandbox: FileSandbox,
  sha: string,
  test: TestFile,
): Promise<Verification> {
  await resetWorkspace(sandbox, sha);
  return runTest(sandbox, test);
}

/** Puts the workspace back at `sha` and removes untracked files (node_modules stays). */
export async function resetWorkspace(sandbox: ExecLike, sha: string): Promise<void> {
  if (!COMMIT_SHA.test(sha)) {
    throw new Error("Refusing to reset to an invalid commit");
  }
  // git clean without -x keeps ignored files such as node_modules, so no reinstall is needed.
  const reset = await sandbox.exec(
    strictScript([`git reset -q --hard ${sha}`, "git clean -fdq", "git rev-parse HEAD"]),
    { cwd: WORKSPACE_DIR, timeout: 60_000 },
  );
  const head = reset.stdout.trim().split("\n").at(-1);
  if (reset.exitCode !== 0 || head !== sha) {
    throw new Error(`Could not reset the workspace to ${sha}: ${clean(reset.stderr, 300)}`);
  }
}

/** Writes the test file into the workspace as it is and runs only that file. */
export async function runTest(sandbox: FileSandbox, test: TestFile): Promise<Verification> {
  if (!isAllowedTestPath(test.path)) {
    throw new Error("Refusing to run a test outside tests/");
  }
  const target = `${WORKSPACE_DIR}/${test.path}`;
  await sandbox.exec(`mkdir -p '${target.slice(0, target.lastIndexOf("/"))}'`);
  await sandbox.writeFile(target, test.content, { encoding: "utf-8" });

  let exitCode: number;
  try {
    const run = await sandbox.exec(
      `rm -f ${RESULT_FILE} && pnpm exec vitest run '${test.path}' --reporter=json --outputFile=${RESULT_FILE}`,
      { cwd: WORKSPACE_DIR, timeout: 180_000 },
    );
    exitCode = run.exitCode;
  } catch (error) {
    return {
      testFile: test.path,
      testSha256: test.sha256,
      passed: 0,
      failed: 0,
      failures: [],
      status: "invalid",
      reason: `the test run did not finish: ${error instanceof Error ? clean(error.message, 200) : "unknown"}`,
    };
  }
  const result = await sandbox.exec(`cat ${RESULT_FILE}`);
  return interpretVitest(result.exitCode === 0 ? result.stdout : "", exitCode, test);
}

/**
 * The harness, not the model, decides the final outcome. A claimed reproduction stands only if
 * the trusted re-run was red; otherwise it is downgraded. Other claims are passed through.
 */
export function decideOutcome(claimed: Outcome, verification: Verification | null): Verdict {
  if (claimed !== "reproduced") {
    return {
      outcome: claimed,
      claimed,
      verified: false,
      note: "Nothing to verify: the agent did not claim a reproduction.",
    };
  }
  if (verification?.status === "red") {
    return {
      outcome: "reproduced",
      claimed,
      verified: true,
      note: "Verified: the agent's test failed on a clean checkout of the base commit.",
    };
  }
  return {
    outcome: "cannot-reproduce",
    claimed,
    verified: false,
    note: `Downgraded from reproduced: ${verification?.reason ?? "the test could not be re-run"}.`,
  };
}
