import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5173/channels/github/webhook" },
    repo: { type: "string", default: "omkarkhair/adlc-demo-app" },
    "repo-id": { type: "string" },
    number: { type: "string", default: "1" },
    title: { type: "string" },
    "body-file": { type: "string" },
    author: { type: "string", default: "workshop-participant" },
    event: { type: "string", default: "issues" },
    action: { type: "string", default: "opened" },
    delivery: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

function readDevVar(name: string): string | undefined {
  if (process.env[name]) {
    return process.env[name];
  }
  if (!existsSync(".dev.vars")) {
    return undefined;
  }
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] === name) {
      return match[2]?.replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

async function lookUpRepo(repo: string): Promise<{ id: number; default_branch: string }> {
  if (values["repo-id"]) {
    return { id: Number(values["repo-id"]), default_branch: "main" };
  }
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "adlc-triage-test-webhook" },
  });
  if (!response.ok) {
    throw new Error(`Could not look up ${repo} (${response.status}); pass --repo-id`);
  }
  return (await response.json()) as { id: number; default_branch: string };
}

const secret = readDevVar("GITHUB_WEBHOOK_SECRET");
if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is not set in the environment or .dev.vars");
  process.exit(1);
}
if (!values.title) {
  console.error('Usage: pnpm webhook:send --title "Issue title" --body-file issue.md [--number 1]');
  process.exit(1);
}

const repo = values.repo ?? "";
const issueNumber = Number(values.number);
const body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : "";
const { id: repoId, default_branch } = await lookUpRepo(repo);
const [owner = "", name = ""] = repo.split("/");
const user = { login: values.author, id: 1, type: "User" };

const payload = {
  action: values.action,
  issue: {
    number: issueNumber,
    title: values.title,
    body,
    html_url: `https://github.com/${repo}/issues/${issueNumber}`,
    user,
    state: "open",
  },
  repository: { id: repoId, name, full_name: repo, default_branch, owner: { login: owner } },
  sender: user,
};

const raw = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const delivery = values.delivery ?? randomUUID();

if (values["dry-run"]) {
  console.log(JSON.stringify({ url: values.url, delivery, signature, payload }, null, 2));
  process.exit(0);
}

const response = await fetch(values.url ?? "", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/adlc-test",
    "x-github-event": values.event ?? "issues",
    "x-github-delivery": delivery,
    "x-hub-signature-256": signature,
  },
  body: raw,
});
console.log(`${response.status} ${response.statusText}`);
console.log(await response.text());
