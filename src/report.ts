import { STATUS_ORDER, type AuditResult } from "./types.js";

const CSV_FIELDS = [
  "status", "service", "region", "resource", "component", "version", "product",
  "cycle", "latest", "supportUntil", "eol", "extendedSupport", "note",
] as const;

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote when needed; prefix formula-like cells so spreadsheets don't execute them.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(result: AuditResult): string {
  const rows = result.components.map((c) => CSV_FIELDS.map((f) => csvCell(c[f])).join(","));
  return [CSV_FIELDS.join(","), ...rows].join("\n") + "\n";
}

export function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function toMarkdown(result: AuditResult, title = `EOL audit: account ${result.accountId}`): string {
  const date = result.finishedAt.slice(0, 10);
  const lines = [`# ${title} (${date})`, "", `Regions: ${result.regions.join(", ")}`, "",
    "| Status | Count |", "|---|---|"];
  for (const s of STATUS_ORDER) if (result.summary[s]) lines.push(`| ${s} | ${result.summary[s]} |`);
  for (const status of STATUS_ORDER) {
    const rows = result.components.filter((c) => c.status === status);
    if (!rows.length) continue;
    lines.push("", `## ${status} (${rows.length})`, "",
      "| Service | Region | Resource | Component | Version | EOL | Latest | Note |",
      "|---|---|---|---|---|---|---|---|");
    for (const c of rows) {
      lines.push(`| ${[c.service, c.region, c.resource, c.component, c.version, c.eol, c.latest, c.note].map(mdCell).join(" | ")} |`);
    }
  }
  if (result.errors.length) {
    lines.push("", `## Skipped (${result.errors.length})`, "", "| Region | Service | Error |", "|---|---|---|");
    for (const e of result.errors) lines.push(`| ${e.region} | ${e.service} | ${mdCell(e.code)} |`);
  }
  return lines.join("\n") + "\n";
}
