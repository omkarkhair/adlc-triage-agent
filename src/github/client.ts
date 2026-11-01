const API = "https://api.github.com";
const REPO_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

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
    if (!this.canWrite) {
      throw new Error("GITHUB_TOKEN is not set");
    }
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
