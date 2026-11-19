import { paginateDescribeSecurityGroups, paginateDescribeVpcs, EC2Client, type IpPermission, type SecurityGroup } from "@aws-sdk/client-ec2";
import { paginateListProjects, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { paginateListPipelines, CodePipelineClient } from "@aws-sdk/client-codepipeline";
import { AutoScalingClient, paginateDescribeAutoScalingInstances } from "@aws-sdk/client-auto-scaling";
import { ApplicationAutoScalingClient, paginateDescribeScalableTargets } from "@aws-sdk/client-application-auto-scaling";
import { ECSClient, paginateListClusters, paginateListServices } from "@aws-sdk/client-ecs";
import { FilterLogEventsCommand, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeCanariesCommand, SyntheticsClient } from "@aws-sdk/client-synthetics";
import { paginateListHealthChecks, Route53Client } from "@aws-sdk/client-route-53";
import { BackupClient, paginateListBackupPlans } from "@aws-sdk/client-backup";
import { DescribeContinuousBackupsCommand, DynamoDBClient, paginateListTables } from "@aws-sdk/client-dynamodb";
import { CloudWatchClient, paginateDescribeAlarms } from "@aws-sdk/client-cloudwatch";
import { DescribeKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { BudgetsClient, paginateDescribeBudgets } from "@aws-sdk/client-budgets";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { GetBucketEncryptionCommand, GetPublicAccessBlockCommand, ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { APIGatewayClient, GetStagesCommand, paginateGetRestApis } from "@aws-sdk/client-api-gateway";
import { capped, CheckError, errCode, errText, tagValue, MAX_EVIDENCE, type Ctx, type CredentialRow } from "./context.js";
import type { CheckResult, Verdict } from "./types.js";

export type Check = (ctx: Ctx) => Promise<CheckResult>;

const res = (verdict: Verdict, evidence: string[]): CheckResult => ({ verdict, evidence });
const skipped = (errors: string[]) => errors.map((e) => `Skipped ${e}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (n: number, d: number) => Math.floor((n * 100) / d);

async function collect<T, R>(gen: AsyncIterable<T>, pick: (page: T) => R[] | undefined): Promise<R[]> {
  const out: R[] = [];
  for await (const page of gen) out.push(...(pick(page) ?? []));
  return out;
}

const nonRoot = (rows: CredentialRow[]) => rows.filter((r) => r.user !== "<root_account>");
const keysActive = (r: CredentialRow) => r.access_key_1_active === "true" || r.access_key_2_active === "true";

// --- TD. 3 ---------------------------------------------------------------------------------

const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*_(dev|develop|development|qa|test|uat|stg|stage|staging|preprod|prod|production|demo|sandbox)$/i;

export const checkTd3: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const vpcs = await collect(paginateDescribeVpcs({ client: ctx.client(EC2Client, region) }, {}), (p) => p.Vpcs);
    const defaultIds = new Set(vpcs.filter((v) => v.IsDefault).map((v) => v.VpcId));
    const custom = vpcs.filter((v) => !v.IsDefault).map((v) => ({ id: v.VpcId ?? "", name: tagValue(v.Tags, "Name") }));
    const instances = await ctx.ec2Instances(region);
    const inDefault = instances.filter((i) => i.VpcId && defaultIds.has(i.VpcId))
      .map((i) => `EC2 ${tagValue(i.Tags, "Name") || i.InstanceId}`);
    inDefault.push(...(await ctx.rdsInstances(region))
      .filter((d) => d.DBSubnetGroup?.VpcId && defaultIds.has(d.DBSubnetGroup.VpcId))
      .map((d) => `RDS ${d.DBInstanceIdentifier}`));
    inDefault.push(...(await ctx.lambdas(region))
      .filter((f) => f.VpcConfig?.VpcId && defaultIds.has(f.VpcConfig.VpcId))
      .map((f) => `Lambda ${f.FunctionName}`));
    return { custom, inDefault, instances: instances.length };
  });
  const custom = results.flatMap(([r, v]) => v.custom.map((c) => ({ region: r, ...c })));
  const inDefault = results.flatMap(([r, v]) => v.inDefault.map((x) => `${r}: ${x}`));
  const badlyNamed = custom.filter((c) => !ENV_NAME_RE.test(c.name))
    .map((c) => (c.name ? `${c.region}: ${c.id} named '${c.name}'` : `${c.region}: ${c.id} has no Name tag`));
  const ev = [`${custom.length} custom VPC(s): ${custom.slice(0, 8).map((c) => c.name || c.id).join(", ")}`];
  if (inDefault.length) ev.push("Resources in a default VPC:", ...capped(inDefault));
  if (badlyNamed.length) ev.push("Not matching PROJECT_ENV naming:", ...capped(badlyNamed));
  ev.push(...skipped(errors));
  if (inDefault.length) return res("FAIL", ev);
  if (!custom.length) return res(results.some(([, v]) => v.instances) ? "REVIEW" : "N/A", ev);
  return res(badlyNamed.length ? "REVIEW" : "PASS", ev);
};

// --- TD. 4 ---------------------------------------------------------------------------------

export const checkTd4: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => ({
    builds: await collect(paginateListProjects({ client: ctx.client(CodeBuildClient, region) }, {}), (p) => p.projects),
    pipes: (await collect(paginateListPipelines({ client: ctx.client(CodePipelineClient, region) }, {}), (p) => p.pipelines))
      .map((p) => p.name ?? ""),
  }));
  const builds = results.flatMap(([r, v]) => v.builds.map((b) => `${r}: ${b}`));
  const pipes = results.flatMap(([r, v]) => v.pipes.map((p) => `${r}: ${p}`));
  const ev = [`${builds.length} CodeBuild project(s), ${pipes.length} CodePipeline pipeline(s)`,
    ...capped(builds, 6), ...capped(pipes, 6), ...skipped(errors)];
  if (builds.length && pipes.length) return res("PASS", ev);
  if (!builds.length && !pipes.length) {
    return res("FAIL", [...ev, "No AWS CI/CD found; CI/CD may run elsewhere (e.g. GitHub Actions)"]);
  }
  return res("REVIEW", ev);
};

// --- TD. 5 ---------------------------------------------------------------------------------

export const checkTd5: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const running = (await ctx.ec2Instances(region)).filter((i) => i.State?.Name === "running");
    const inAsg = new Set((await collect(
      paginateDescribeAutoScalingInstances({ client: ctx.client(AutoScalingClient, region) }, {}),
      (p) => p.AutoScalingInstances)).map((a) => a.InstanceId));
    const loose = running.filter((i) => !inAsg.has(i.InstanceId)).map((i) => tagValue(i.Tags, "Name") || i.InstanceId || "?");
    const ecs = ctx.client(ECSClient, region);
    const services: string[] = [];
    for (const cluster of await collect(paginateListClusters({ client: ecs }, {}), (p) => p.clusterArns)) {
      for (const arn of await collect(paginateListServices({ client: ecs }, { cluster }), (p) => p.serviceArns)) {
        if (arn.includes("/")) services.push(arn.split("/").slice(1).join("/"));
      }
    }
    const targets = new Set((await collect(
      paginateDescribeScalableTargets({ client: ctx.client(ApplicationAutoScalingClient, region) }, { ServiceNamespace: "ecs" }),
      (p) => p.ScalableTargets)).map((t) => (t.ResourceId ?? "").split("/").slice(1).join("/")));
    return { running: running.length, loose, services: services.length, noScaling: services.filter((s) => !targets.has(s)) };
  });
  const running = sum(results.map(([, v]) => v.running));
  const services = sum(results.map(([, v]) => v.services));
  const loose = results.flatMap(([r, v]) => v.loose.map((n) => `${r}: ${n}`));
  const noScaling = results.flatMap(([r, v]) => v.noScaling.map((n) => `${r}: ${n}`));
  const ev = [`${running} running EC2 instance(s), ${loose.length} outside an Auto Scaling group`,
    `${services} ECS service(s), ${noScaling.length} without auto scaling`];
  if (loose.length) ev.push("EC2 not in an ASG:", ...capped(loose));
  if (noScaling.length) ev.push("ECS services without auto scaling:", ...capped(noScaling));
  ev.push(...skipped(errors));
  if (!running && !services) return res("N/A", [...ev, "No servers to assess (serverless or empty account)"]);
  if (loose.length) return res("FAIL", ev);
  return res(noScaling.length ? "REVIEW" : "PASS", ev);
};

// --- IS. 2 to 5 (IAM) ----------------------------------------------------------------------

export const checkIs2: Check = async (ctx) => {
  const admins = new Set((await ctx.adminPrincipals()).users);
  const offenders = nonRoot(await ctx.credentialReport()).filter((r) => admins.has(r.user!) && keysActive(r)).map((r) => r.user!);
  const ev = [`${admins.size} IAM user(s) with AdministratorAccess (direct or via group)`,
    "Custom admin-equivalent policies are not detected"];
  if (offenders.length) return res("FAIL", [...ev, "Admin users with active access keys (CLI enabled):", ...capped(offenders)]);
  return res("PASS", ev);
};

export const checkIs3: Check = async (ctx) => {
  const report = nonRoot(await ctx.credentialReport());
  const withKeys = report.filter(keysActive).map((r) => {
    const used = [1, 2].filter((n) => r[`access_key_${n}_active`] === "true").map((n) => r[`access_key_${n}_last_used_date`] || "N/A");
    return `${r.user} (last used ${used.sort().at(-1) ?? "N/A"})`;
  });
  const ev = [`${report.length} IAM user(s), ${withKeys.length} with active access keys`];
  return withKeys.length ? res("FAIL", [...ev, ...capped(withKeys)]) : res("PASS", ev);
};

export const checkIs4: Check = async (ctx) => {
  const root = (await ctx.credentialReport()).find((r) => r.user === "<root_account>");
  if (!root) throw new CheckError("root row missing from credential report");
  const problems: string[] = [];
  if (keysActive(root)) problems.push("Root user has active access keys");
  if (root.mfa_active !== "true") problems.push("Root user has no MFA");
  const ev = [`Root MFA: ${root.mfa_active}`, `Root access keys active: ${keysActive(root)}`,
    `Root password last used: ${root.password_last_used || "N/A"}`];
  return res(problems.length ? "FAIL" : "PASS", [...problems, ...ev]);
};

export const checkIs5: Check = async (ctx) => {
  const consoleUsers = nonRoot(await ctx.credentialReport()).filter((r) => r.password_enabled === "true");
  const noMfa = consoleUsers.filter((r) => r.mfa_active !== "true").map((r) => r.user!);
  const ev = [`${consoleUsers.length} IAM user(s) with console passwords, ${noMfa.length} without MFA`];
  if (!consoleUsers.length) ev.push("No IAM console users; people probably sign in through SSO");
  return noMfa.length ? res("FAIL", [...ev, "Console users without MFA:", ...capped(noMfa)]) : res("PASS", ev);
};

// --- IS. 6 ---------------------------------------------------------------------------------

function openToWorld(perm: IpPermission, port: number): boolean {
  if (perm.IpProtocol !== "-1" && perm.IpProtocol !== "tcp") return false;
  if (perm.IpProtocol === "tcp" && !((perm.FromPort ?? 0) <= port && port <= (perm.ToPort ?? 65535))) return false;
  return !!perm.IpRanges?.some((r) => r.CidrIp === "0.0.0.0/0") || !!perm.Ipv6Ranges?.some((r) => r.CidrIpv6 === "::/0");
}

export const checkIs6: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const dbs = await ctx.rdsInstances(region);
    const publicDbs = dbs.filter((d) => d.PubliclyAccessible).map((d) => d.DBInstanceIdentifier ?? "?");
    const sgIds = [...new Set(dbs.flatMap((d) => (d.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId!).filter(Boolean)))].sort();
    const sgs = new Map<string, SecurityGroup>();
    if (sgIds.length) {
      for (const sg of await collect(paginateDescribeSecurityGroups({ client: ctx.client(EC2Client, region) }, { GroupIds: sgIds }), (p) => p.SecurityGroups)) {
        if (sg.GroupId) sgs.set(sg.GroupId, sg);
      }
    }
    const openSg: string[] = [];
    for (const d of dbs) {
      const port = d.Endpoint?.Port ?? d.DbInstancePort ?? 0;
      for (const g of d.VpcSecurityGroups ?? []) {
        const sg = sgs.get(g.VpcSecurityGroupId ?? "");
        if (sg?.IpPermissions?.some((p) => openToWorld(p, port))) openSg.push(`${d.DBInstanceIdentifier} via ${g.VpcSecurityGroupId}`);
      }
    }
    return { total: dbs.length, publicDbs, openSg };
  });
  const total = sum(results.map(([, v]) => v.total));
  const publicDbs = results.flatMap(([r, v]) => v.publicDbs.map((x) => `${r}: ${x}`));
  const openSg = results.flatMap(([r, v]) => v.openSg.map((x) => `${r}: ${x}`));
  const ev = [`${total} RDS/Aurora/DocumentDB instance(s)`, ...skipped(errors)];
  if (!total) return res("N/A", ev);
  if (publicDbs.length) ev.push("PubliclyAccessible = true:", ...capped(publicDbs));
  if (openSg.length) ev.push("Security group open to the internet on the DB port:", ...capped(openSg));
  return res(publicDbs.length || openSg.length ? "FAIL" : "PASS", ev);
};

// --- IS. 7 and IS. 8 (logs) ----------------------------------------------------------------

export const checkIs7: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion((r) => ctx.logGroups(r));
  const groups = results.flatMap(([, g]) => g);
  const never = groups.filter((g) => g.retentionInDays === undefined).length;
  const gb = sum(groups.map((g) => g.storedBytes ?? 0)) / 1024 ** 3;
  const ev = [`${groups.length} log group(s), ${gb.toFixed(1)} GB stored, ${never} with no retention limit`, ...skipped(errors)];
  return groups.length ? res("REVIEW", ev) : res("FAIL", [...ev, "No CloudWatch log groups"]);
};

const LEVEL_KEYS = new Set(["level", "severity", "levelname", "log.level", "loglevel"]);
const REQID_KEYS = new Set(["requestid", "request_id", "reqid", "awsrequestid", "traceid", "correlationid"]);
const LAMBDA_NOISE = ["START ", "END ", "REPORT ", "INIT_START", "EXTENSION", "TELEMETRY"];

/** Parse a log line as JSON, tolerating Lambda's 'timestamp<TAB>id<TAB>LEVEL<TAB>' prefix. */
export function jsonPart(message: string): Record<string, unknown> | null {
  const text = message.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const checkIs8: Check = async (ctx) => {
  if (!ctx.sampleLogs) {
    return res("UNKNOWN", ["Skipped: log sampling is opt-in (run with --sample-logs; the client must deploy the role with AllowLogSampling=true)"]);
  }
  const startTime = Date.now() - 86_400_000;
  const stats: { name: string; n: number; js: number; lvl: number; req: number }[] = [];
  const errors: string[] = [];
  for (const region of ctx.regions) {
    const top = [...(await ctx.logGroups(region))].sort((a, b) => (b.storedBytes ?? 0) - (a.storedBytes ?? 0)).slice(0, 5);
    const logs = ctx.client(CloudWatchLogsClient, region);
    for (const g of top) {
      try {
        const events = (await logs.send(new FilterLogEventsCommand({ logGroupName: g.logGroupName, startTime, limit: 50 }))).events ?? [];
        const lines = events.map((e) => e.message ?? "").filter((m) => !LAMBDA_NOISE.some((p) => m.startsWith(p)));
        if (!lines.length) continue;
        const parsed = lines.map(jsonPart).filter((p): p is Record<string, unknown> => p !== null); // counted, never stored
        const keys = parsed.map((p) => new Set(Object.keys(p).map((k) => k.toLowerCase())));
        stats.push({
          name: `${region}: ${g.logGroupName}`, n: lines.length, js: parsed.length,
          lvl: keys.filter((k) => [...LEVEL_KEYS].some((x) => k.has(x))).length,
          req: keys.filter((k) => [...REQID_KEYS].some((x) => k.has(x))).length,
        });
      } catch (err) {
        errors.push(`${region}: ${g.logGroupName}: ${errText(err)}`);
      }
    }
  }
  if (!stats.length) {
    if (errors.length) throw new CheckError(errors.slice(0, 3).join("; "));
    return res("N/A", ["No log lines in the last 24 hours in the largest log groups"]);
  }
  const total = sum(stats.map((s) => s.n));
  const jsP = pct(sum(stats.map((s) => s.js)), total);
  const lvlP = pct(sum(stats.map((s) => s.lvl)), total);
  const reqP = pct(sum(stats.map((s) => s.req)), total);
  const ev = [`Overall: ${jsP}% JSON, ${lvlP}% with level, ${reqP}% with request ID (${total} sampled lines)`,
    ...capped(stats.map((s) => `${s.name}: ${s.n} lines, ${pct(s.js, s.n)}% JSON, ${pct(s.lvl, s.n)}% with level, ${pct(s.req, s.n)}% with request ID`)),
    ...skipped(errors)];
  if (jsP < 50) return res("FAIL", ev);
  return res(jsP >= 90 && lvlP >= 90 && reqP >= 50 ? "PASS" : "REVIEW", ev);
};

// --- IS. 10 --------------------------------------------------------------------------------

export const checkIs10: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const syn = ctx.client(SyntheticsClient, region);
    const names: string[] = [];
    let token: string | undefined;
    do {
      const page = await syn.send(new DescribeCanariesCommand(token ? { NextToken: token } : {}));
      names.push(...(page.Canaries ?? []).map((c) => c.Name ?? ""));
      token = page.NextToken;
    } while (token);
    return names;
  });
  const found = results.flatMap(([r, ns]) => ns.map((n) => `${r}: ${n}`));
  let checks = 0;
  try {
    checks = (await collect(paginateListHealthChecks({ client: ctx.client(Route53Client) }, {}), (p) => p.HealthChecks)).length;
  } catch (err) {
    errors.push(`route53: ${errText(err)}`);
  }
  const ev = [`${found.length} Synthetics canary(ies), ${checks} Route 53 health check(s)`, ...capped(found, 6), ...skipped(errors)];
  return found.length || checks ? res("PASS", ev) : res("REVIEW", [...ev, "No AWS-side uptime monitoring; check external tools"]);
};

// --- IS. 11 --------------------------------------------------------------------------------

export const checkIs11: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const instances = await ctx.rdsInstances(region);
    const clusters = await ctx.rdsClusters(region);
    const noBackup = [
      ...instances.filter((d) => !d.DBClusterIdentifier && (d.BackupRetentionPeriod ?? 0) === 0).map((d) => d.DBInstanceIdentifier ?? "?"),
      ...clusters.filter((c) => (c.BackupRetentionPeriod ?? 0) === 0).map((c) => c.DBClusterIdentifier ?? "?"),
    ];
    const plans = (await collect(paginateListBackupPlans({ client: ctx.client(BackupClient, region) }, {}), (p) => p.BackupPlansList))
      .map((p) => p.BackupPlanName ?? "");
    const ddb = ctx.client(DynamoDBClient, region);
    const tables = await collect(paginateListTables({ client: ddb }, {}), (p) => p.TableNames);
    const noPitr: string[] = [];
    for (const t of tables) {
      const status = (await ddb.send(new DescribeContinuousBackupsCommand({ TableName: t })))
        .ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus;
      if (status !== "ENABLED") noPitr.push(t);
    }
    return { dbs: instances.length + clusters.length, noBackup, plans, tables: tables.length, noPitr };
  });
  const dbs = sum(results.map(([, v]) => v.dbs));
  const tables = sum(results.map(([, v]) => v.tables));
  const plans = results.flatMap(([r, v]) => v.plans.map((p) => `${r}: ${p}`));
  const noBackup = results.flatMap(([r, v]) => v.noBackup.map((x) => `${r}: ${x}`));
  const noPitr = results.flatMap(([r, v]) => v.noPitr.map((t) => ({ r, t, hasPlan: v.plans.length > 0 })));
  const ev = [`${dbs} RDS instance(s)/cluster(s), ${tables} DynamoDB table(s), ${plans.length} AWS Backup plan(s)`, ...capped(plans, 6)];
  if (noBackup.length) ev.push("RDS with automated backups disabled:", ...capped(noBackup));
  if (noPitr.length) {
    ev.push("DynamoDB without point-in-time recovery:",
      ...capped(noPitr.map((x) => `${x.r}: ${x.t}${x.hasPlan ? " (a Backup plan exists in this region)" : ""}`)));
  }
  ev.push(...skipped(errors));
  if (!dbs && !tables) return res("N/A", ev);
  if (noBackup.length || noPitr.some((x) => !x.hasPlan)) return res("FAIL", ev);
  return res(noPitr.length ? "REVIEW" : "PASS", ev);
};

// --- IS. 12 --------------------------------------------------------------------------------

export const checkIs12: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const out: { name: string; enabled: boolean; actions: number; state?: string }[] = [];
    for await (const p of paginateDescribeAlarms({ client: ctx.client(CloudWatchClient, region) }, {})) {
      for (const a of [...(p.MetricAlarms ?? []), ...(p.CompositeAlarms ?? [])]) {
        out.push({ name: a.AlarmName ?? "?", enabled: !!a.ActionsEnabled, actions: a.AlarmActions?.length ?? 0, state: a.StateValue });
      }
    }
    return out;
  });
  const alarms = results.flatMap(([, a]) => a);
  const notifying = alarms.filter((a) => a.enabled && a.actions > 0);
  const firing = alarms.filter((a) => a.state === "ALARM").map((a) => a.name);
  const ev = [`${alarms.length} alarm(s), ${notifying.length} with notification actions, ${firing.length} in ALARM`];
  if (firing.length) ev.push("Currently in ALARM:", ...capped(firing, 6));
  ev.push(...skipped(errors));
  if (!alarms.length) return res("FAIL", [...ev, "No CloudWatch alarms"]);
  return notifying.length ? res("PASS", ev) : res("FAIL", [...ev, "No alarm notifies anyone"]);
};

// --- IS. 13 and IS. 20 (database encryption) -----------------------------------------------

type DbEnc = "unencrypted" | "AWS-managed key" | "customer-managed key";

async function dbEncryption(ctx: Ctx, region: string): Promise<[string, DbEnc][]> {
  const kms = ctx.client(KMSClient, region);
  const seen = new Set<string>();
  const out: [string, DbEnc][] = [];
  for (const d of await ctx.rdsInstances(region)) {
    const name = d.DBClusterIdentifier ?? d.DBInstanceIdentifier ?? "?";
    if (seen.has(name)) continue;
    seen.add(name);
    if (!d.StorageEncrypted) { out.push([name, "unencrypted"]); continue; }
    const keyId = d.KmsKeyId;
    const manager = keyId
      ? await ctx.cached(`kms:${keyId}`, async () => (await kms.send(new DescribeKeyCommand({ KeyId: keyId }))).KeyMetadata?.KeyManager)
      : "AWS";
    out.push([name, manager === "CUSTOMER" ? "customer-managed key" : "AWS-managed key"]);
  }
  return out;
}

export const checkIs13: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion((r) => dbEncryption(ctx, r));
  const dbs = results.flatMap(([r, rows]) => rows.map(([n, s]) => [`${r}: ${n}`, s] as const));
  const count = (k: DbEnc) => dbs.filter(([, s]) => s === k).length;
  const ev = [`${dbs.length} database(s): ${count("customer-managed key")} customer-managed key, ${count("AWS-managed key")} AWS-managed key, ${count("unencrypted")} unencrypted`,
    ...dbs.filter(([, s]) => s !== "customer-managed key").map(([n, s]) => `${n}: ${s}`).slice(0, MAX_EVIDENCE), ...skipped(errors)];
  if (!dbs.length) return res("N/A", ev);
  if (count("unencrypted")) return res("FAIL", ev);
  return res(count("AWS-managed key") ? "REVIEW" : "PASS", ev);
};

// --- IS. 16 --------------------------------------------------------------------------------

export const checkIs16: Check = async (ctx) => {
  const comps = await ctx.eolComponents();
  const bad = comps.filter((c) => ["EOL", "EOL_EXTENDED_SUPPORT", "DEPRECATED"].includes(c.status));
  const soon = comps.filter((c) => ["EOL_SOON", "SECURITY_ONLY"].includes(c.status));
  const ev = [`${comps.length} versioned component(s): ${bad.length} past EOL or deprecated, ${soon.length} nearing EOL or security-only, ${comps.filter((c) => c.status === "UNKNOWN").length} unidentified`,
    ...capped([...bad, ...soon].map((c) => `${c.status}: ${c.service} ${c.resource} (${c.component} ${c.version}, EOL ${c.eol})`)),
    "Full detail: run the audit command"];
  if (bad.length) return res("FAIL", ev);
  return res(soon.length ? "REVIEW" : "PASS", ev);
};

// --- IS. 17 --------------------------------------------------------------------------------

export const checkIs17: Check = async (ctx) => {
  const admins = await ctx.adminPrincipals();
  const ev = [`AdministratorAccess: ${admins.users.length} user(s), ${admins.groups.length} group(s), ${admins.roles.length} role(s)`,
    ...capped([...admins.roles.map((r) => `role: ${r}`), ...admins.users.map((u) => `user: ${u}`)], 10)];
  try {
    const budgets = await collect(paginateDescribeBudgets({ client: ctx.client(BudgetsClient) }, { AccountId: ctx.accountId }), (p) => p.Budgets);
    ev.push(`${budgets.length} AWS Budget(s)${budgets.length ? "" : ": no budgets configured"}`);
  } catch (err) {
    ev.push(`Budgets not checked: ${errText(err)}`);
  }
  try {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const back = new Date(end.getTime() - 85 * 86_400_000);
    const start = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth(), 1));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const resp = await ctx.client(CostExplorerClient).send(new GetCostAndUsageCommand({ // USD 0.01 per request
      TimePeriod: { Start: iso(start), End: iso(end) }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"],
    }));
    for (const p of resp.ResultsByTime ?? []) {
      const cost = p.Total?.UnblendedCost;
      ev.push(`Spend ${p.TimePeriod?.Start?.slice(0, 7)}: ${Number(cost?.Amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cost?.Unit ?? ""}`.trim());
    }
  } catch (err) {
    ev.push(`Spend not checked: ${errText(err)}`);
  }
  return res("REVIEW", ev);
};

// --- IS. 19 and IS. 20 ---------------------------------------------------------------------

async function macieEvidence(ctx: Ctx): Promise<string> {
  try {
    return `Macie: ${(await ctx.macie()).map(([r, s]) => `${r} ${s}`).join(", ")}`;
  } catch (err) {
    return `Macie not checked: ${(err as Error).message}`;
  }
}

export const checkIs19: Check = async (ctx) => {
  const s3 = ctx.client(S3Client, undefined, { followRegionRedirects: true });
  const buckets = ((await s3.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name ?? "").filter(Boolean);
  const unencrypted: string[] = [], noPab: string[] = [], errors: string[] = [];
  for (const b of buckets) {
    try {
      await s3.send(new GetBucketEncryptionCommand({ Bucket: b }));
    } catch (err) {
      if (errCode(err) === "ServerSideEncryptionConfigurationNotFoundError") unencrypted.push(b);
      else errors.push(`${b}: ${errText(err)}`);
    }
    try {
      const cfg = (await s3.send(new GetPublicAccessBlockCommand({ Bucket: b }))).PublicAccessBlockConfiguration ?? {};
      if (!(cfg.BlockPublicAcls && cfg.IgnorePublicAcls && cfg.BlockPublicPolicy && cfg.RestrictPublicBuckets)) noPab.push(b);
    } catch (err) {
      if (errCode(err) === "NoSuchPublicAccessBlockConfiguration") noPab.push(b);
      else errors.push(`${b}: ${errText(err)}`);
    }
  }
  const ev = [`${buckets.length} S3 bucket(s), ${unencrypted.length} without default encryption, ${noPab.length} without a full public access block`];
  if (unencrypted.length) ev.push("Unencrypted:", ...capped(unencrypted));
  if (noPab.length) ev.push("Public access not fully blocked:", ...capped(noPab));
  ev.push(await macieEvidence(ctx), ...skipped(errors.slice(0, 5)));
  return res(unencrypted.length ? "FAIL" : "REVIEW", ev);
};

export const checkIs20: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion((r) => ctx.logGroups(r));
  const groups = results.flatMap(([, g]) => g);
  const masked = groups.filter((g) => g.dataProtectionStatus === "ACTIVATED").length;
  const ev = [`${masked} of ${groups.length} log group(s) have a data protection (masking) policy`];
  let unenc: string[] = [];
  try {
    const enc = await ctx.perRegion((r) => dbEncryption(ctx, r));
    unenc = enc.results.flatMap(([r, rows]) => rows.filter(([, s]) => s === "unencrypted").map(([n]) => `${r}: ${n}`));
    ev.push(`Unencrypted databases: ${unenc.length}`, ...capped(unenc, 6));
  } catch (err) {
    ev.push(`Database encryption not checked: ${(err as Error).message}`);
  }
  ev.push(await macieEvidence(ctx), ...skipped(errors));
  return res(unenc.length ? "FAIL" : "REVIEW", ev);
};

// --- EG. 21 --------------------------------------------------------------------------------

const APM_PATTERN = /newrelic|new-relic|datadog|dynatrace|xray|aws-otel|opentelemetry|otel|elastic-apm/i;

export const checkEg21: Check = async (ctx) => {
  const { results, errors } = await ctx.perRegion(async (region) => {
    const fns = await ctx.lambdas(region);
    const traced = fns.filter((f) => f.TracingConfig?.Mode === "Active").map((f) => f.FunctionName ?? "?");
    const apmLayers = fns.filter((f) => f.Layers?.some((l) => APM_PATTERN.test(l.Arn ?? ""))).map((f) => f.FunctionName ?? "?");
    const gw = ctx.client(APIGatewayClient, region);
    const stages: string[] = [];
    for (const api of await collect(paginateGetRestApis({ client: gw }, {}), (p) => p.items)) {
      for (const s of (await gw.send(new GetStagesCommand({ restApiId: api.id }))).item ?? []) {
        if (s.tracingEnabled) stages.push(`${api.name}/${s.stageName}`);
      }
    }
    return { fns: fns.length, traced, apmLayers, stages };
  });
  const tag = (pick: (v: (typeof results)[number][1]) => string[]) => results.flatMap(([r, v]) => pick(v).map((x) => `${r}: ${x}`));
  const traced = tag((v) => v.traced), layers = tag((v) => v.apmLayers), stages = tag((v) => v.stages);
  const sidecars = [...new Set((await ctx.eolComponents())
    .filter((c) => c.service === "ecs" && APM_PATTERN.test(`${c.component} ${c.version}`))
    .map((c) => `${c.region}: ${c.resource} (${c.version})`))].sort();
  const ev = [`Lambda: ${traced.length} of ${sum(results.map(([, v]) => v.fns))} with X-Ray active tracing, ${layers.length} with an APM layer`,
    `API Gateway stages with X-Ray tracing: ${stages.length}`,
    `ECS containers with an APM/tracing image: ${sidecars.length}`,
    ...capped([...traced, ...layers, ...stages, ...sidecars]), ...skipped(errors)];
  if (traced.length || layers.length || stages.length || sidecars.length) return res("PASS", ev);
  return res("REVIEW", [...ev, "No AWS-visible tracing or APM; check for APM agents in application code"]);
};

export const CHECKS: Record<string, Check> = {
  "TD. 3": checkTd3, "TD. 4": checkTd4, "TD. 5": checkTd5, "IS. 2": checkIs2, "IS. 3": checkIs3,
  "IS. 4": checkIs4, "IS. 5": checkIs5, "IS. 6": checkIs6, "IS. 7": checkIs7, "IS. 8": checkIs8,
  "IS. 10": checkIs10, "IS. 11": checkIs11, "IS. 12": checkIs12, "IS. 13": checkIs13, "IS. 16": checkIs16,
  "IS. 17": checkIs17, "IS. 19": checkIs19, "IS. 20": checkIs20, "EG. 21": checkEg21,
};
