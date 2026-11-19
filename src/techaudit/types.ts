import type { AwsClientOptions } from "../types.js";

export type Verdict = "PASS" | "FAIL" | "REVIEW" | "N/A" | "UNKNOWN";
/** Order used in summaries: things needing attention first. */
export const VERDICT_ORDER: readonly Verdict[] = ["FAIL", "REVIEW", "UNKNOWN", "PASS", "N/A"];

export interface Question {
  /** Section reference as written in the questionnaire, e.g. "IS. 6". */
  sec: string;
  group: string;
  name: string;
  traceability: string;
  /** Full: AWS alone answers it. Partial: the AWS side only. */
  coverage: "Full" | "Partial";
  stillToConfirm: string;
  /** What the check looks at (for the report appendix). */
  scope: string;
  /** Client-role permissions the check needs. */
  permissions: string;
}

export interface CheckResult {
  verdict: Verdict;
  evidence: string[];
}

export interface QuestionResult {
  question: Question;
  result: CheckResult;
}

export interface TechAuditResult {
  accountId: string;
  regions: string[];
  startedAt: string;
  finishedAt: string;
  results: QuestionResult[];
}

export interface TechAuditOptions extends AwsClientOptions {
  /** Regions to scan. Default: all regions enabled in the account. */
  regions?: string[];
  /** Section references to run, e.g. ["IS. 6", "IS.13"]. Default: all. */
  only?: string[];
  /** Opt-in for IS. 8: reads a small sample of log lines. The client role must allow it. */
  sampleLogs?: boolean;
  /** Test hook: pause between credential-report polls. Default 2000 ms. */
  pollMs?: number;
}
