import { DescribeDBClustersCommand, DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { runAudit } from "../src/audit.js";
import { EolClient, type EolCycle } from "../src/eol.js";
import { toCsv, toMarkdown } from "../src/report.js";

const sts = mockClient(STSClient);
const lambda = mockClient(LambdaClient);
const rds = mockClient(RDSClient);

const DATA: Record<string, EolCycle[]> = {
  "aws-lambda": [{ cycle: "nodejs16.x", support: "2024-06-12", eol: "2027-08-31" }, { cycle: "nodejs22.x", support: "2027-04-30", eol: "2027-08-31" }],
  "amazon-rds-postgresql": [{ cycle: "13", eol: "2026-02-28", extendedSupport: "2029-02-28" }],
};
const eolClient = () => new EolClient({
  fetch: (async (url: string) => {
    const product = url.split("/").pop()!.replace(".json", "");
    return DATA[product] ? Response.json(DATA[product]) : new Response("", { status: 404 });
  }) as typeof globalThis.fetch,
});

afterEach(() => { sts.reset(); lambda.reset(); rds.reset(); });

describe("runAudit", () => {
  it("collects, assesses and isolates collector failures", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "222222222222", Arn: "arn:aws:sts::222222222222:assumed-role/x/y" });
    lambda.on(ListFunctionsCommand).resolves({ Functions: [
      { FunctionName: "legacy", Runtime: "nodejs16.x" },
      { FunctionName: "current", Runtime: "nodejs22.x" },
      { FunctionName: "image-fn" },
    ] });
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });
    rds.on(DescribeDBInstancesCommand, {}).resolves({ DBInstances: [
      { DBInstanceIdentifier: "orders-db", Engine: "postgres", EngineVersion: "13.11" },
    ] });

    const result = await runAudit({
      regions: ["eu-west-2", "us-east-1"], services: ["lambda", "rds"], today: "2026-11-19", eolClient: eolClient(),
    });

    expect(result.accountId).toBe("222222222222");
    // 3 functions + 1 DB, in each of 2 regions (mocks answer every region).
    expect(result.components).toHaveLength(8);
    expect(result.summary).toMatchObject({ DEPRECATED: 2, EOL_EXTENDED_SUPPORT: 2, OK: 2, UNKNOWN: 2 });
    expect(result.components[0]!.status).toBe("EOL_EXTENDED_SUPPORT"); // worst first
    expect(result.errors).toEqual([]);

    expect(toCsv(result).split("\n")[0]).toBe("status,service,region,resource,component,version,product,cycle,latest,supportUntil,eol,extendedSupport,note");
    expect(toMarkdown(result)).toContain("## DEPRECATED (2)");
  });

  it("returns AccessDenied as an error instead of failing the audit", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "222222222222" });
    lambda.on(ListFunctionsCommand).rejects(Object.assign(new Error("not authorised"), { name: "AccessDeniedException" }));
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] });

    const result = await runAudit({ regions: ["eu-west-2"], services: ["lambda", "rds"], eolClient: eolClient() });
    expect(result.components).toEqual([]);
    expect(result.errors).toEqual([{ service: "lambda", region: "eu-west-2", code: "AccessDeniedException", message: "not authorised" }]);
    expect(toMarkdown(result)).toContain("## Skipped (1)");
  });

  it("rejects invalid options before calling AWS", async () => {
    await expect(runAudit({ regions: ["not a region"] })).rejects.toThrow(/Invalid regions/);
    await expect(runAudit({ services: ["s3" as never] })).rejects.toThrow(/Unknown services/);
    await expect(runAudit({ warnDays: -1 })).rejects.toThrow(/warnDays/);
    expect(sts.calls()).toHaveLength(0);
  });

  it("guards CSV cells against spreadsheet formula injection", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "222222222222" });
    lambda.on(ListFunctionsCommand).resolves({ Functions: [{ FunctionName: "=HYPERLINK(\"x\")", Runtime: "nodejs22.x" }] });
    const result = await runAudit({ regions: ["eu-west-2"], services: ["lambda"], eolClient: eolClient() });
    expect(toCsv(result)).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
