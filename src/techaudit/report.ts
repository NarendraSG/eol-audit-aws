import { csvCell, mdCell } from "../report.js";
import { NOT_FROM_AWS, QUESTIONNAIRE_TOTAL, QUESTIONS } from "./questions.js";
import { VERDICT_ORDER, type QuestionResult, type TechAuditResult, type Verdict } from "./types.js";

const CSV_FIELDS = ["sec", "group", "question", "traceability", "coverage", "verdict", "evidence",
  "still_to_confirm", "aws_evidence_checked", "permissions_needed"] as const;

const VERDICT_MEANING: Record<Verdict, string> = {
  PASS: "AWS evidence meets the expectation (for Partial questions, only the AWS side)",
  FAIL: "AWS evidence shows a gap (listed in the evidence column)",
  REVIEW: "Evidence collected, but a person must judge it",
  "N/A": "Nothing to assess, e.g. no databases in the account",
  UNKNOWN: "The check could not run, usually a missing permission (see the table below) or an unsupported region",
};

const evidenceCell = (r: QuestionResult) => r.result.evidence.map(mdCell).join("<br>") || "-";

export function toTechAuditCsv(result: TechAuditResult): string {
  const rows = result.results.map(({ question: q, result: r }) => [
    q.sec, q.group, q.name, q.traceability, q.coverage, r.verdict, r.evidence.join("\n"),
    q.stillToConfirm, q.scope, q.permissions,
  ].map(csvCell).join(","));
  return [CSV_FIELDS.join(","), ...rows].join("\n") + "\n";
}

function coverageSection(result: TechAuditResult): string[] {
  const full = result.results.filter((r) => r.question.coverage === "Full");
  const partial = result.results.filter((r) => r.question.coverage === "Partial");
  const lines = ["", "## Questionnaire coverage and evidence", "",
    `Source: *Engg Tech Audit Questionnaire*, Project Audit 4.0 (${QUESTIONNAIRE_TOTAL} questions). ${QUESTIONS.length} can be answered from AWS through the read-only role; this run covered ${result.results.length} (${full.length} fully, ${partial.length} partially answerable).`];
  if (full.length) {
    lines.push("", "### Fully answerable", "",
      "| Sec. # | Name | AWS evidence collected | Verdict | Evidence from this run |", "|---|---|---|---|---|");
    for (const r of full) {
      lines.push(`| ${r.question.sec} | ${mdCell(r.question.name)} | ${mdCell(r.question.scope)} | **${r.result.verdict}** | ${evidenceCell(r)} |`);
    }
  }
  if (partial.length) {
    lines.push("", "### Partially answerable", "", "A `PASS` here covers the AWS side only.", "",
      "| Sec. # | Name | AWS evidence collected | Verdict | Evidence from this run | Still to confirm |", "|---|---|---|---|---|---|");
    for (const r of partial) {
      lines.push(`| ${r.question.sec} | ${mdCell(r.question.name)} | ${mdCell(r.question.scope)} | **${r.result.verdict}** | ${evidenceCell(r)} | ${mdCell(r.question.stillToConfirm) || "-"} |`);
    }
  }
  const ran = new Set(result.results.map((r) => r.question.sec));
  const skipped = QUESTIONS.filter((q) => !ran.has(q.sec)).map((q) => q.sec);
  if (skipped.length) lines.push("", `Not run in this report (\`--only\` was used): ${skipped.join(", ")}.`);
  return lines;
}

function aboutSection(result: TechAuditResult): string[] {
  const lines = ["", "## About this report", "", "### Verdicts", "", "| Verdict | Meaning |", "|---|---|",
    ...VERDICT_ORDER.map((v) => `| \`${v}\` | ${VERDICT_MEANING[v]} |`), "",
    "For Partial questions, the \"Still to confirm\" column says what the auditor must check outside AWS.", "",
    "### What each check looked at", "", "| Sec. # | AWS evidence collected | Client-role permissions needed |", "|---|---|---|",
    ...result.results.map((r) => `| ${r.question.sec} | ${mdCell(r.question.scope)} | ${mdCell(r.question.permissions)} |`), "",
    "Clients onboarded before these checks existed must update their CloudFormation stack to grant the extra read-only permissions; until then those checks report `UNKNOWN`.",
    "", "### Not answerable from AWS", "", NOT_FROM_AWS];
  return lines;
}

export function toTechAuditMarkdown(result: TechAuditResult, title = `Engg Tech Audit (AWS checks): account ${result.accountId}`): string {
  const counts = VERDICT_ORDER.map((v) => [v, result.results.filter((r) => r.result.verdict === v).length] as const);
  const lines = [`# ${title} (${result.finishedAt.slice(0, 10)})`, "", `Regions: ${result.regions.join(", ")}`, "",
    "| Verdict | Count |", "|---|---|", ...counts.filter(([, n]) => n).map(([v, n]) => `| ${v} | ${n} |`), "",
    "| Sec. # | Group name | Name | Traceability | Coverage | Verdict | Evidence | Still to confirm |",
    "|---|---|---|---|---|---|---|---|"];
  for (const r of result.results) {
    const q = r.question;
    lines.push(`| ${q.sec} | ${q.group} | ${mdCell(q.name)} | ${q.traceability || "None listed"} | ${q.coverage} | **${r.result.verdict}** | ${evidenceCell(r)} | ${mdCell(q.stillToConfirm) || "-"} |`);
  }
  lines.push(...coverageSection(result), ...aboutSection(result));
  return lines.join("\n") + "\n";
}
