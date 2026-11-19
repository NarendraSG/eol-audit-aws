import { paginateDescribeInstances, type Instance } from "@aws-sdk/client-ec2";
import { EC2Client } from "@aws-sdk/client-ec2";
import { paginateListEntitiesForPolicy, paginateGetGroup, GenerateCredentialReportCommand, GetCredentialReportCommand, IAMClient } from "@aws-sdk/client-iam";
import { paginateDescribeLogGroups, CloudWatchLogsClient, type LogGroup } from "@aws-sdk/client-cloudwatch-logs";
import { paginateDescribeDBClusters, paginateDescribeDBInstances, RDSClient, type DBCluster, type DBInstance } from "@aws-sdk/client-rds";
import { LambdaClient, paginateListFunctions, type FunctionConfiguration } from "@aws-sdk/client-lambda";
import { GetMacieSessionCommand, Macie2Client } from "@aws-sdk/client-macie2";
import { clientConfig } from "../collectors/index.js";
import type { AssessedComponent, AwsClientOptions } from "../types.js";

export const GLOBAL_REGION = "us-east-1"; // IAM, Route 53, Budgets and Cost Explorer endpoints
export const ADMIN_POLICY = "arn:aws:iam::aws:policy/AdministratorAccess";
export const MAX_EVIDENCE = 12;

/** A check could not run (e.g. denied in every region). Reported as UNKNOWN. */
export class CheckError extends Error {}

export function errText(err: unknown): string {
  const e = err as { name?: string; Code?: string; message?: string };
  const text = `${e?.Code ?? e?.name ?? "Error"}: ${(e?.message ?? "").split("\n")[0] ?? ""}`.trim();
  return text.slice(0, 200);
}

export function errCode(err: unknown): string {
  const e = err as { name?: string; Code?: string };
  return e?.Code ?? e?.name ?? "";
}

export function tagValue(tags: { Key?: string; Value?: string }[] | undefined, key: string): string {
  return tags?.find((t) => t.Key === key)?.Value ?? "";
}

export function capped(items: string[], limit = MAX_EVIDENCE): string[] {
  return items.length > limit ? [...items.slice(0, limit), `... and ${items.length - limit} more`] : items;
}

export type CredentialRow = Record<string, string>;

/** Minimal RFC 4180 parser (IAM user names may contain commas, so the report can quote fields). */
export function parseCsv(text: string): CredentialRow[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export interface CtxOptions extends AwsClientOptions {
  accountId: string;
  regions: string[];
  sampleLogs: boolean;
  pollMs: number;
  /** Lazily provides the EOL inventory for IS. 16 and EG. 21. */
  eolComponents: () => Promise<AssessedComponent[]>;
}

/** One credentials/regions setup shared by all checks, with cached lookups several checks reuse. */
export class Ctx {
  private readonly store = new Map<string, Promise<unknown>>();
  constructor(readonly opts: CtxOptions) {}

  get regions(): string[] { return this.opts.regions; }
  get accountId(): string { return this.opts.accountId; }
  get sampleLogs(): boolean { return this.opts.sampleLogs; }

  client<T>(Ctor: new (config: any) => T, region: string = GLOBAL_REGION, extra: object = {}): T {
    return new Ctor({ ...clientConfig({ region, ...this.opts }), ...extra });
  }

  cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let hit = this.store.get(key) as Promise<T> | undefined;
    if (!hit) { hit = fn(); this.store.set(key, hit); }
    return hit;
  }

  /** Run fn in every region. Throws CheckError only when every region failed. */
  async perRegion<T>(fn: (region: string) => Promise<T>): Promise<{ results: [string, T][]; errors: string[] }> {
    const settled = await Promise.allSettled(this.regions.map((r) => fn(r)));
    const results: [string, T][] = [];
    const errors: string[] = [];
    settled.forEach((s, i) => {
      const region = this.regions[i]!;
      if (s.status === "fulfilled") results.push([region, s.value]);
      else errors.push(`${region}: ${errText(s.reason)}`);
    });
    if (errors.length && !results.length) throw new CheckError(errors.slice(0, 3).join("; "));
    return { results, errors };
  }

  ec2Instances(region: string): Promise<Instance[]> {
    return this.cached(`ec2:${region}`, async () => {
      const out: Instance[] = [];
      const client = this.client(EC2Client, region);
      for await (const page of paginateDescribeInstances({ client }, {
        Filters: [{ Name: "instance-state-name", Values: ["running", "stopped"] }],
      })) for (const r of page.Reservations ?? []) out.push(...(r.Instances ?? []));
      return out;
    });
  }

  rdsInstances(region: string): Promise<DBInstance[]> {
    return this.cached(`rds:${region}`, async () => {
      const out: DBInstance[] = [];
      for await (const p of paginateDescribeDBInstances({ client: this.client(RDSClient, region) }, {})) out.push(...(p.DBInstances ?? []));
      return out;
    });
  }

  rdsClusters(region: string): Promise<DBCluster[]> {
    return this.cached(`rds-cl:${region}`, async () => {
      const out: DBCluster[] = [];
      for await (const p of paginateDescribeDBClusters({ client: this.client(RDSClient, region) }, {})) out.push(...(p.DBClusters ?? []));
      return out;
    });
  }

  lambdas(region: string): Promise<FunctionConfiguration[]> {
    return this.cached(`lambda:${region}`, async () => {
      const out: FunctionConfiguration[] = [];
      for await (const p of paginateListFunctions({ client: this.client(LambdaClient, region) }, {})) out.push(...(p.Functions ?? []));
      return out;
    });
  }

  logGroups(region: string): Promise<LogGroup[]> {
    return this.cached(`logs:${region}`, async () => {
      const out: LogGroup[] = [];
      for await (const p of paginateDescribeLogGroups({ client: this.client(CloudWatchLogsClient, region) }, {})) out.push(...(p.logGroups ?? []));
      return out;
    });
  }

  credentialReport(): Promise<CredentialRow[]> {
    return this.cached("credreport", async () => {
      const iam = this.client(IAMClient);
      let state: string | undefined;
      for (let i = 0; i < 15; i++) {
        state = (await iam.send(new GenerateCredentialReportCommand({}))).State;
        if (state === "COMPLETE") break;
        await new Promise((r) => setTimeout(r, this.opts.pollMs));
      }
      if (state !== "COMPLETE") throw new CheckError("credential report was not ready in time");
      const content = (await iam.send(new GetCredentialReportCommand({}))).Content;
      return parseCsv(content ? new TextDecoder().decode(content) : "");
    });
  }

  /** Users (direct or via group), groups and roles with AdministratorAccess. */
  adminPrincipals(): Promise<{ users: string[]; groups: string[]; roles: string[] }> {
    return this.cached("admins", async () => {
      const iam = this.client(IAMClient);
      const users = new Set<string>(), groups: string[] = [], roles: string[] = [];
      for await (const p of paginateListEntitiesForPolicy({ client: iam }, { PolicyArn: ADMIN_POLICY })) {
        for (const u of p.PolicyUsers ?? []) if (u.UserName) users.add(u.UserName);
        for (const g of p.PolicyGroups ?? []) if (g.GroupName) groups.push(g.GroupName);
        for (const r of p.PolicyRoles ?? []) if (r.RoleName) roles.push(r.RoleName);
      }
      for (const g of groups) {
        for await (const p of paginateGetGroup({ client: iam }, { GroupName: g })) {
          for (const u of p.Users ?? []) if (u.UserName) users.add(u.UserName);
        }
      }
      return { users: [...users].sort(), groups: groups.sort(), roles: roles.sort() };
    });
  }

  eolComponents(): Promise<AssessedComponent[]> {
    return this.cached("eol", () => this.opts.eolComponents());
  }

  /** Macie status per region. */
  macie(): Promise<[string, string][]> {
    return this.cached("macie", async () => {
      const { results } = await this.perRegion(async (region) => {
        try {
          return (await this.client(Macie2Client, region).send(new GetMacieSessionCommand({}))).status ?? "UNKNOWN";
        } catch (err) {
          if (/not enabled/i.test(errText(err))) return "DISABLED";
          throw err;
        }
      });
      return results;
    });
  }
}
