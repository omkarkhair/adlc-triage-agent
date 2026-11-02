const API = "https://api.github.com";
const REPO_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface IssueComment {
  id: number;
  body?: string;
}

/** One file in a new tree: its new text, or `null` to delete it. */
export interface TreeFile {
  path: string;
  content: string | null;
}

export interface PullRequest {
  number: number;
  url: string;
  draft: boolean;
}

/**
 * The few GitHub REST calls the triage run needs. The token is a fine-grained personal access
 * token scoped to your fork; it stays in the Worker and never enters the sandbox.
 */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string | undefined,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch.bind(globalThis);
  }

  get canWrite(): boolean {
    return Boolean(this.token?.trim());
  }

  private async request(method: string, path: string, body?: unknown, accept?: string) {
    const headers: Record<string, string> = {
      accept: accept ?? "application/vnd.github+json",
      "user-agent": "adlc-triage-agent",
      "x-github-api-version": "2022-11-28",
    };
    if (this.canWrite) {
      headers.authorization = `Bearer ${this.token?.trim()}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub ${method} ${path} returned ${response.status}`,
      );
    }
    return response;
  }

  /** The commit sha a branch points at right now. The run pins this sha. */
  async resolveBranchHead(repo: string, branch: string): Promise<string> {
    checkRepo(repo);
    const response = await this.request(
      "GET",
      `/repos/${repo}/commits/${encodeURIComponent(branch)}`,
      undefined,
      "application/vnd.github.sha",
    );
    const sha = (await response.text()).trim();
    if (!COMMIT_SHA.test(sha)) {
      throw new Error("GitHub returned an invalid commit sha");
    }
    return sha;
  }

  /**
   * Creates a comment on the issue, or updates our earlier one. The marker (an HTML comment,
   * invisible on GitHub) finds the earlier comment, so a retried step never posts twice.
   */
  async upsertComment(
    repo: string,
    issueNumber: number,
    marker: string,
    text: string,
  ): Promise<{ commentId: number; action: "created" | "updated" }> {
    checkRepo(repo);
    this.requireToken();
    const body = `${marker}\n${text}`;
    const existing = await this.findComment(repo, issueNumber, marker);
    if (existing !== null) {
      await this.request("PATCH", `/repos/${repo}/issues/comments/${existing}`, { body });
      return { commentId: existing, action: "updated" };
    }
    const response = await this.request("POST", `/repos/${repo}/issues/${issueNumber}/comments`, {
      body,
    });
    const created = (await response.json()) as { id: number };
    return { commentId: created.id, action: "created" };
  }

  /** The tree of a commit. */
  async commitTree(repo: string, sha: string): Promise<string> {
    checkRepo(repo);
    checkSha(sha);
    const response = await this.request("GET", `/repos/${repo}/git/commits/${sha}`);
    const commit = (await response.json()) as { tree: { sha: string } };
    return commit.tree.sha;
  }

  /**
   * Writes a tree: the base tree with these files replaced, added or deleted. Git trees are
   * content-addressed, so the same files on the same base always give the same tree sha.
   */
  async createTree(repo: string, baseTree: string, files: TreeFile[]): Promise<string> {
    checkRepo(repo);
    this.requireToken();
    const tree = files.map((file) =>
      file.content === null
        ? { path: file.path, mode: "100644", type: "blob", sha: null }
        : { path: file.path, mode: "100644", type: "blob", content: file.content },
    );
    const response = await this.request("POST", `/repos/${repo}/git/trees`, {
      base_tree: baseTree,
      tree,
    });
    return ((await response.json()) as { sha: string }).sha;
  }

  /** Creates a commit object. It belongs to no branch until a ref points at it. */
  async createCommit(repo: string, message: string, tree: string, parent: string) {
    checkRepo(repo);
    checkSha(parent);
    this.requireToken();
    const response = await this.request("POST", `/repos/${repo}/git/commits`, {
      message,
      tree,
      parents: [parent],
    });
    return ((await response.json()) as { sha: string }).sha;
  }

  /** The commit a branch points at, or `null` if the branch does not exist. */
  async branchHead(repo: string, branch: string): Promise<string | null> {
    checkRepo(repo);
    checkBranch(branch);
    try {
      const response = await this.request("GET", `/repos/${repo}/git/ref/heads/${branch}`);
      return ((await response.json()) as { object: { sha: string } }).object.sha;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Creates a new branch at a commit. Fails if the branch already exists. */
  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    checkRepo(repo);
    checkBranch(branch);
    checkSha(sha);
    this.requireToken();
    await this.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /** An open or closed pull request from this branch of the same repository, if any. */
  async findPullRequest(repo: string, branch: string): Promise<PullRequest | null> {
    checkRepo(repo);
    checkBranch(branch);
    const owner = repo.split("/")[0];
    const head = encodeURIComponent(`${owner}:${branch}`);
    const response = await this.request("GET", `/repos/${repo}/pulls?head=${head}&state=all`);
    const pulls = (await response.json()) as {
      number: number;
      html_url: string;
      draft?: boolean;
    }[];
    const pull = pulls[0];
    return pull ? { number: pull.number, url: pull.html_url, draft: Boolean(pull.draft) } : null;
  }

  /** Opens a draft pull request. A draft can't be merged until a person marks it ready. */
  async createDraftPullRequest(
    repo: string,
    pull: { title: string; body: string; head: string; base: string },
  ): Promise<PullRequest> {
    checkRepo(repo);
    checkBranch(pull.head);
    checkBranch(pull.base);
    this.requireToken();
    const response = await this.request("POST", `/repos/${repo}/pulls`, { ...pull, draft: true });
    const created = (await response.json()) as { number: number; html_url: string };
    return { number: created.number, url: created.html_url, draft: true };
  }

  private requireToken(): void {
    if (!this.canWrite) {
      throw new Error("GITHUB_TOKEN is not set");
    }
  }

  private async findComment(repo: string, issueNumber: number, marker: string) {
    for (let page = 1; page <= 3; page++) {
      const response = await this.request(
        "GET",
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      const comments = (await response.json()) as IssueComment[];
      const match = comments.find((comment) => comment.body?.startsWith(marker));
      if (match) {
        return match.id;
      }
      if (comments.length < 100) {
        break;
      }
    }
    return null;
  }
}

/** The invisible marker that identifies one kind of comment for one run. */
export function commentMarker(runId: string, kind: string): string {
  return `<!-- adlc-triage:${runId}:${kind} -->`;
}

function checkRepo(repo: string): void {
  if (!REPO_FULL_NAME.test(repo)) {
    throw new Error("Invalid repository name");
  }
}

function checkSha(sha: string): void {
  if (!COMMIT_SHA.test(sha)) {
    throw new Error("Invalid commit sha");
  }
}

function checkBranch(branch: string): void {
  if (!BRANCH.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new Error("Invalid branch name");
  }
}
