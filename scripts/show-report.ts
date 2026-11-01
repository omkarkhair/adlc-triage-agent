import { execFileSync } from "node:child_process";

const BUCKET = "adlc-triage-reports";
const FILES = ["report.md", "candidate.patch", "candidate.json"];
const issue = process.argv[2] ?? "";
const file = process.argv[3] ?? "report.md";

if (!/^\d{1,10}$/.test(issue) || !FILES.includes(file)) {
  console.error(`Usage: pnpm report <issue-number> [${FILES.join(" | ")}]`);
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
      `${BUCKET}/runs/issue-${issue}/${file}`,
      "--remote",
      "--pipe",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} catch {
  console.error(
    `\nNo ${file} for issue ${issue} yet. The agent may still be running, or it ended without saving one (check the logs for agent.finished).`,
  );
  process.exit(1);
}
