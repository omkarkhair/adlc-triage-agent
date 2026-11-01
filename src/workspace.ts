export const WORKSPACE_DIR = "/workspace";

const REPO_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The part of a Cloudflare Sandbox this module uses (easy to fake in tests). */
export interface ExecLike {
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class WorkspaceError extends Error {
  constructor(step: string, output: string) {
    super(`${step} failed: ${output.trim().slice(-500) || "no output"}`);
    this.name = "WorkspaceError";
  }
}

/**
 * Puts the repository at exactly `sha` in `dir` and installs its dependencies. Trusted code does
 * this, not the agent, so the agent works on the commit the run pinned. Safe to repeat: an
 * existing checkout is reset to the sha and stray files are removed (node_modules stays).
 */
export async function prepareWorkspace(
  sandbox: ExecLike,
  repo: string,
  sha: string,
  dir: string = WORKSPACE_DIR,
): Promise<{ sha: string }> {
  if (!REPO_FULL_NAME.test(repo) || !COMMIT_SHA.test(sha)) {
    throw new Error("Refusing to prepare a workspace for an invalid repository or commit");
  }
  const git = "git -c advice.detachedHead=false";
  const checkout = [
    "set -e",
    `mkdir -p ${dir}`,
    `cd ${dir}`,
    `if [ ! -d .git ]; then git init -q && git remote add origin https://github.com/${repo}.git; fi`,
    `${git} fetch -q --depth 1 origin ${sha}`,
    `${git} checkout -q --force --detach ${sha}`,
    "git clean -fdq",
    "git rev-parse HEAD",
  ].join("\n");
  const fetched = await sandbox.exec(checkout, { cwd: "/", timeout: 120_000 });
  if (fetched.exitCode !== 0) {
    throw new WorkspaceError("git checkout", fetched.stderr || fetched.stdout);
  }
  const head = fetched.stdout.trim().split("\n").at(-1);
  if (head !== sha) {
    throw new WorkspaceError("git checkout", `expected ${sha}, got ${head ?? "nothing"}`);
  }

  const install = await sandbox.exec("pnpm install --frozen-lockfile --reporter=append-only", {
    cwd: dir,
    timeout: 300_000,
  });
  if (install.exitCode !== 0) {
    throw new WorkspaceError("pnpm install", install.stderr || install.stdout);
  }
  return { sha };
}
