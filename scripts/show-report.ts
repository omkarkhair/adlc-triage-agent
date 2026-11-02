import { execFileSync } from "node:child_process";

const BUCKET = "adlc-triage-reports";
const issue = process.argv[2] ?? "";

if (!/^\d{1,10}$/.test(issue)) {
  console.error("Usage: pnpm report <issue-number>");
  process.exit(1);
}

try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `${BUCKET}/runs/issue-${issue}/report.md`,
      "--remote",
      "--pipe",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} catch {
  console.error(
    `\nNo report for issue ${issue} yet. The agent may still be running, or it ended without saving one (check the logs for agent.finished).`,
  );
  process.exit(1);
}
