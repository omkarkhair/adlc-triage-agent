import * as v from "valibot";

export const OUTCOMES = ["reproduced", "cannot-reproduce", "needs-information"] as const;

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

export const ReproOutcome = v.object({
  outcome: v.picklist(OUTCOMES),
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
  expected: text(1_000),
  observed: text(2_000),
  testFile: v.optional(v.pipe(v.string(), v.regex(/^tests\/[A-Za-z0-9._/-]+\.test\.ts$/))),
  missingInformation: v.optional(text(1_000)),
  hypothesis: v.optional(text(1_000)),
});

export type ReproOutcome = v.InferOutput<typeof ReproOutcome>;

export function checkOutcome(outcome: ReproOutcome): string | null {
  if (outcome.outcome === "reproduced" && !outcome.testFile) {
    return "A reproduced outcome needs testFile: the path of the test you ran and saw fail.";
  }
  if (outcome.outcome === "needs-information" && !outcome.missingInformation?.trim()) {
    return "A needs-information outcome needs missingInformation: what the reporter must add.";
  }
  if (outcome.testFile?.split("/").includes("..")) {
    return "testFile must be a path inside tests/.";
  }
  return null;
}
