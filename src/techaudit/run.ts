import { callerAccountId, enabledRegions, runAudit } from "../audit.js";
import type { AwsClientOptions } from "../types.js";
import { CHECKS } from "./checks.js";
import { CheckError, Ctx, errText } from "./context.js";
import { normaliseSec, QUESTIONS } from "./questions.js";
import type { CheckResult, Question, QuestionResult, TechAuditOptions, TechAuditResult } from "./types.js";

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** Run one check. A failure becomes UNKNOWN with the reason; it never stops the audit. */
export async function runCheck(ctx: Ctx, q: Question): Promise<CheckResult> {
  const check = CHECKS[q.sec];
  if (!check) return { verdict: "UNKNOWN", evidence: ["No check is registered for this question"] };
  try {
    return await check(ctx);
  } catch (err) {
    return { verdict: "UNKNOWN", evidence: [`Could not run: ${err instanceof CheckError ? err.message : errText(err)}`] };
  }
}

/**
 * Answer the questions of the Engg Tech Audit that AWS can speak to, using read-only calls.
 * Throws only when the credentials themselves are unusable or the options are invalid.
 */
export async function runTechAudit(opts: TechAuditOptions = {}): Promise<TechAuditResult> {
  if (opts.regions) {
    const bad = opts.regions.filter((r) => !REGION_RE.test(r));
    if (bad.length) throw new Error(`Invalid regions: ${bad.join(", ")}`);
  }
  let questions = [...QUESTIONS];
  if (opts.only?.length) {
    const wanted = new Set(opts.only.map(normaliseSec));
    questions = questions.filter((q) => wanted.has(normaliseSec(q.sec)));
    const unknown = [...wanted].filter((w) => !questions.some((q) => normaliseSec(q.sec) === w));
    if (unknown.length) {
      throw new Error(`Unknown question(s): ${unknown.join(", ")}; valid: ${QUESTIONS.map((q) => normaliseSec(q.sec)).join(", ")}`);
    }
  }

  const startedAt = new Date().toISOString();
  const aws: AwsClientOptions = { credentials: opts.credentials, endpoint: opts.endpoint, maxAttempts: opts.maxAttempts };
  const first = opts.regions?.[0];
  const { account } = await callerAccountId({ ...aws, region: first });
  const regions = opts.regions?.length ? [...opts.regions] : await enabledRegions({ ...aws, region: first });

  const ctx = new Ctx({
    ...aws, accountId: account, regions, sampleLogs: opts.sampleLogs ?? false, pollMs: opts.pollMs ?? 2000,
    // Reuse the EOL audit for IS. 16 and EG. 21; services it cannot read are skipped, not fatal.
    eolComponents: async () => (await runAudit({ ...aws, regions })).components,
  });
  const results: QuestionResult[] = [];
  for (const question of questions) results.push({ question, result: await runCheck(ctx, question) });
  return { accountId: account, regions, startedAt, finishedAt: new Date().toISOString(), results };
}
