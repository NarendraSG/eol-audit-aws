import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GenerateCredentialReportCommand, GetCredentialReportCommand, IAMClient } from "@aws-sdk/client-iam";
import { DescribeDBClustersCommand, DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { checkIs12, checkIs3, checkIs4, checkIs6, jsonPart } from "../src/techaudit/checks.js";
import { Ctx, parseCsv } from "../src/techaudit/context.js";
import { toTechAuditCsv, toTechAuditMarkdown } from "../src/techaudit/report.js";
import { QUESTIONS } from "../src/techaudit/questions.js";
import { runCheck } from "../src/techaudit/run.js";
import type { TechAuditResult } from "../src/techaudit/types.js";

const iam = mockClient(IAMClient);
const rds = mockClient(RDSClient);
const ec2 = mockClient(EC2Client);
const cw = mockClient(CloudWatchClient);
afterEach(() => { iam.reset(); rds.reset(); ec2.reset(); cw.reset(); });

const ctx = (regions = ["eu-west-2"]) => new Ctx({
  accountId: "111111111111", regions, sampleLogs: false, pollMs: 0, eolComponents: async () => [],
});

const REPORT = [
  "user,password_enabled,mfa_active,access_key_1_active,access_key_1_last_used_date,access_key_2_active,access_key_2_last_used_date,password_last_used",
  "<root_account>,not_supported,false,true,N/A,false,N/A,2026-01-01",
  "alice,true,false,true,2026-10-01,false,N/A,N/A",
  '"bob,jr",true,true,false,N/A,false,N/A,N/A',
].join("\n");

function seedReport() {
  iam.on(GenerateCredentialReportCommand).resolves({ State: "COMPLETE" });
  iam.on(GetCredentialReportCommand).resolves({ Content: new TextEncoder().encode(REPORT) });
}

describe("helpers", () => {
  it("parses quoted CSV fields", () => {
    const rows = parseCsv(REPORT);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.user).toBe("bob,jr");
  });

  it("reads JSON after a Lambda prefix and rejects plain text", () => {
    expect(jsonPart('2026-01-01T00:00:00Z\tabc\tINFO\t{"level":"info"}')).toEqual({ level: "info" });
    expect(jsonPart("plain line")).toBeNull();
    expect(jsonPart("[1,2]")).toBeNull();
  });
});

describe("checks", () => {
  it("IS. 3 fails on active access keys and reports last use", async () => {
    seedReport();
    const r = await checkIs3(ctx());
    expect(r.verdict).toBe("FAIL");
    expect(r.evidence.join("\n")).toContain("alice (last used 2026-10-01)");
  });

  it("IS. 4 fails on root keys and missing MFA", async () => {
    seedReport();
    const r = await checkIs4(ctx());
    expect(r.verdict).toBe("FAIL");
    expect(r.evidence).toContain("Root user has active access keys");
    expect(r.evidence).toContain("Root user has no MFA");
  });

  it("IS. 6 flags public databases and security groups open on the DB port", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{
      DBInstanceIdentifier: "orders", PubliclyAccessible: true, Endpoint: { Port: 5432 },
      VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-1" }],
    }] });
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{
      GroupId: "sg-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
    }] });
    const r = await checkIs6(ctx());
    expect(r.verdict).toBe("FAIL");
    expect(r.evidence.join("\n")).toContain("eu-west-2: orders via sg-1");
  });

  it("IS. 6 is N/A with no databases", async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] });
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });
    expect((await checkIs6(ctx())).verdict).toBe("N/A");
  });

  it("IS. 12 fails when no alarm notifies anyone", async () => {
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [{ AlarmName: "cpu", ActionsEnabled: true, AlarmActions: [], StateValue: "OK" }] });
    const r = await checkIs12(ctx());
    expect(r.verdict).toBe("FAIL");
    expect(r.evidence).toContain("No alarm notifies anyone");
  });
});

describe("runCheck", () => {
  it("turns a denied call into UNKNOWN instead of throwing", async () => {
    iam.on(GenerateCredentialReportCommand).rejects(Object.assign(new Error("not allowed"), { name: "AccessDenied" }));
    const q = QUESTIONS.find((x) => x.sec === "IS. 3")!;
    const r = await runCheck(ctx(), q);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.evidence[0]).toContain("AccessDenied");
  });

  it("IS. 8 is UNKNOWN unless sampling is opted in", async () => {
    const r = await runCheck(ctx(), QUESTIONS.find((x) => x.sec === "IS. 8")!);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.evidence[0]).toContain("opt-in");
  });
});

describe("report", () => {
  const sample: TechAuditResult = {
    accountId: "111111111111", regions: ["eu-west-2"], startedAt: "2026-11-19T10:00:00Z", finishedAt: "2026-11-19T10:01:00Z",
    results: [
      { question: QUESTIONS.find((q) => q.sec === "IS. 6")!, result: { verdict: "FAIL", evidence: ["PubliclyAccessible = true:", "eu-west-2: orders"] } },
      { question: QUESTIONS.find((q) => q.sec === "IS. 5")!, result: { verdict: "PASS", evidence: ["a|b"] } },
    ],
  };

  it("appends coverage tables with scope and the run's evidence", () => {
    const md = toTechAuditMarkdown(sample);
    expect(md).toContain("## Questionnaire coverage and evidence");
    expect(md).toContain("### Fully answerable");
    expect(md).toContain("### Partially answerable");
    expect(md).toContain("RDS `PubliclyAccessible` flag");
    expect(md).toContain("PubliclyAccessible = true:<br>eu-west-2: orders");
    expect(md).toContain("a\\|b");
    expect(md).toContain("Not run in this report (`--only` was used): TD. 3");
    expect(md.indexOf("## Questionnaire coverage")).toBeLessThan(md.indexOf("## About this report"));
  });

  it("writes one CSV row per question with scope and permissions", () => {
    const csv = toTechAuditCsv(sample).trim().split("\n");
    expect(csv[0]).toContain("aws_evidence_checked,permissions_needed");
    expect(csv.length).toBeGreaterThan(2);
    expect(csv.join("\n")).toContain("ec2:DescribeSecurityGroups");
  });
});
