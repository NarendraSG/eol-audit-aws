import { DescribeRegionsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { COLLECTORS } from "./collectors/index.js";
import { assessAll, EolClient } from "./eol.js";
import {
  ALL_SERVICES, DEFAULT_SERVICES, STATUS_ORDER,
  type AuditResult, type AwsClientOptions, type CollectorError, type Component, type ServiceName, type Status,
} from "./types.js";

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

export interface AuditOptions extends AwsClientOptions {
  /** Regions to scan. Default: all regions enabled in the account. */
  regions?: string[];
  /** Default: DEFAULT_SERVICES (everything except ssm). */
  services?: ServiceName[];
  /** Flag EOL within this many days as EOL_SOON. Default 180. */
  warnDays?: number;
  /** Max collector calls in flight. Default 4. */
  concurrency?: number;
  /** Inject a shared or custom endoflife.date client (e.g. with caching or a mirror). */
  eolClient?: EolClient;
  /** YYYY-MM-DD override, for reproducible reports/tests. */
  today?: string;
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; Code?: string };
  return e?.Code ?? e?.name ?? "Error";
}

/** Run tasks with a fixed number in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function enabledRegions(opts: AwsClientOptions & { region?: string } = {}): Promise<string[]> {
  const ec2 = new EC2Client({ region: opts.region ?? "us-east-1", credentials: opts.credentials, endpoint: opts.endpoint });
  const res = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  return (res.Regions ?? []).map((r) => r.RegionName).filter((r): r is string => !!r).sort();
}

export async function callerAccountId(opts: AwsClientOptions & { region?: string } = {}): Promise<{ account: string; arn: string }> {
  const sts = new STSClient({ region: opts.region ?? "us-east-1", credentials: opts.credentials, endpoint: opts.endpoint });
  const id = await sts.send(new GetCallerIdentityCommand({}));
  if (!id.Account) throw new Error("STS returned no account ID");
  return { account: id.Account, arn: id.Arn ?? "" };
}

/**
 * Inventory versioned components in one AWS account and assess them against endoflife.date.
 * Only read-only describe/list calls are made. Collector failures are returned in `errors`.
 * Throws only when the credentials themselves are unusable.
 */
export async function runAudit(opts: AuditOptions = {}): Promise<AuditResult> {
  const services = opts.services ?? [...DEFAULT_SERVICES];
  const bad = services.filter((s) => !ALL_SERVICES.includes(s));
  if (bad.length) throw new Error(`Unknown services: ${bad.join(", ")}`);
  const warnDays = opts.warnDays ?? 180;
  if (!Number.isInteger(warnDays) || warnDays < 0) throw new Error("warnDays must be a non-negative integer");
  const concurrency = opts.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (opts.regions) {
    const badRegions = opts.regions.filter((r) => !REGION_RE.test(r));
    if (badRegions.length) throw new Error(`Invalid regions: ${badRegions.join(", ")}`);
  }

  const startedAt = new Date().toISOString();
  const aws: AwsClientOptions = { credentials: opts.credentials, endpoint: opts.endpoint, maxAttempts: opts.maxAttempts };
  const firstRegion = opts.regions?.[0];
  const { account } = await callerAccountId({ ...aws, region: firstRegion });
  const regions = opts.regions?.length ? [...opts.regions] : await enabledRegions({ ...aws, region: firstRegion });

  const errors: CollectorError[] = [];
  const tasks = regions.flatMap((region) => services.map((service) => async (): Promise<Component[]> => {
    try {
      return await COLLECTORS[service]({ ...aws, region });
    } catch (err) {
      errors.push({ service, region, code: errorCode(err), message: (err as Error)?.message ?? String(err) });
      return [];
    }
  }));
  const found = (await pool(tasks, concurrency)).flat();

  const eol = opts.eolClient ?? new EolClient();
  const components = await assessAll(found, eol, { warnDays, today: opts.today });
  components.sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    || a.service.localeCompare(b.service) || a.region.localeCompare(b.region) || a.resource.localeCompare(b.resource));

  const summary = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
  for (const c of components) summary[c.status]++;
  errors.sort((a, b) => a.region.localeCompare(b.region) || a.service.localeCompare(b.service));

  return { accountId: account, regions, startedAt, finishedAt: new Date().toISOString(), components, errors, summary };
}
