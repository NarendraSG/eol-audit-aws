#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fromIni } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { callerAccountId, runAudit } from "./audit.js";
import { assumeRoleCredentials } from "./credentials.js";
import {
  auditClient, techAuditClient, createInvite, FileConnectionStore, quickCreateUrl, STACK_NAME, TEMPLATE_PATH, verifyConnection,
} from "./onboarding.js";
import { toCsv, toMarkdown } from "./report.js";
import { runTechAudit } from "./techaudit/run.js";
import { toTechAuditCsv, toTechAuditMarkdown } from "./techaudit/report.js";
import { VERDICT_ORDER, type TechAuditResult } from "./techaudit/types.js";
import { ALL_SERVICES, STATUS_ORDER, type AuditResult, type ServiceName } from "./types.js";

const USAGE = `aws-eol-audit <command> [options]

Commands
  audit    Inventory an account and check versions against endoflife.date
             --client <name> | --role-arn <arn> [--external-id <id>] | (your own credentials)
             [--regions a,b] [--services lambda,rds,...] [--ssm] [--warn-days 180]
             [--out <dir>] [--json]
  tech-audit  Answer the Engg Tech Audit questions that AWS can speak to (verdict + evidence)
             --client <name> | --role-arn <arn> [--external-id <id>] | (your own credentials)
             [--regions a,b] [--only IS.6,IS.13] [--sample-logs] [--out <dir>] [--json]
  invite   Register a client and print their one-time setup values
             --name <name> [--our-account-id <id>] [--principal-arn <arn>] [--regions a,b]
             [--template-url <s3 url>] [--console-region eu-west-2] [--rotate]
  verify   Record and test the client's role ARN       --name <name> --role-arn <arn>
  list     Show registered clients
  remove   Forget a client locally                     --name <name>

Common
  --profile <name>   Our AWS profile (default: SDK default chain / environment)
  --store <path>     Connection store file (default: $AWS_EOL_AUDIT_STORE or ./clients.json)
  --endpoint <url>   Override AWS endpoint (testing)

Exit codes: 0 ok, 1 something past EOL / a tech-audit FAIL / verify failed, 2 usage or auth error.`;

function list(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const items = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<number> {
  const { positionals, values: o } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" }, store: { type: "string" }, endpoint: { type: "string" },
      client: { type: "string" }, "role-arn": { type: "string" }, "external-id": { type: "string" },
      regions: { type: "string", multiple: true }, services: { type: "string", multiple: true },
      ssm: { type: "boolean" }, only: { type: "string", multiple: true }, "sample-logs": { type: "boolean" }, "warn-days": { type: "string" }, out: { type: "string" }, json: { type: "boolean" },
      name: { type: "string" }, "our-account-id": { type: "string" }, "principal-arn": { type: "string" },
      "template-url": { type: "string" }, "console-region": { type: "string" }, rotate: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (o.help || !cmd) {
    process.stdout.write(`${USAGE}\n`);
    return o.help ? 0 : 2;
  }

  const base: AwsCredentialIdentityProvider | undefined = o.profile ? fromIni({ profile: o.profile }) : undefined;
  const store = new FileConnectionStore(resolve(o.store ?? process.env.AWS_EOL_AUDIT_STORE ?? "clients.json"));
  const endpoint = o.endpoint;

  switch (cmd) {
    case "audit": {
      const services = list(o.services) as ServiceName[] | undefined;
      const unknown = services?.filter((s) => !ALL_SERVICES.includes(s));
      if (unknown?.length) fail(`Unknown services: ${unknown.join(", ")}`);
      if (services && o.ssm && !services.includes("ssm")) services.push("ssm");
      const selected = services ?? (o.ssm ? [...ALL_SERVICES] : undefined);
      const warnDays = o["warn-days"] !== undefined ? Number(o["warn-days"]) : undefined;
      if (warnDays !== undefined && (!Number.isInteger(warnDays) || warnDays < 0)) fail("--warn-days must be a non-negative integer");
      if (o.client && o["role-arn"]) fail("Use either --client or --role-arn, not both");

      const common = { regions: list(o.regions), services: selected, warnDays, endpoint };
      let result: AuditResult;
      try {
        if (o.client) {
          result = await auditClient(store, o.client, { ...common, baseCredentials: base });
        } else {
          const credentials = o["role-arn"]
            ? assumeRoleCredentials({ roleArn: o["role-arn"], externalId: o["external-id"], baseCredentials: base, endpoint })
            : base;
          result = await runAudit({ ...common, credentials });
        }
      } catch (err) {
        fail(`Audit failed: ${(err as Error).message}`);
      }

      if (o.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        for (const s of STATUS_ORDER) if (result.summary[s]) process.stdout.write(`${s.padEnd(22)} ${result.summary[s]}\n`);
        if (result.errors.length) process.stdout.write(`${"SKIPPED".padEnd(22)} ${result.errors.length} (see report)\n`);
      }
      if (o.out) {
        const dir = resolve(o.out);
        await mkdir(dir, { recursive: true });
        const stem = join(dir, `eol-${result.accountId}-${result.finishedAt.slice(0, 10)}`);
        await writeFile(`${stem}.csv`, toCsv(result));
        await writeFile(`${stem}.md`, toMarkdown(result, o.client ? `EOL audit: ${o.client} (${result.accountId})` : undefined));
        process.stderr.write(`Wrote ${stem}.csv and ${stem}.md\n`);
      }
      return result.summary.EOL > 0 ? 1 : 0;
    }

    case "tech-audit": {
      if (o.client && o["role-arn"]) fail("Use either --client or --role-arn, not both");
      const common = { regions: list(o.regions), only: list(o.only), sampleLogs: o["sample-logs"], endpoint };
      let result: TechAuditResult;
      try {
        if (o.client) {
          result = await techAuditClient(store, o.client, { ...common, baseCredentials: base });
        } else {
          const credentials = o["role-arn"]
            ? assumeRoleCredentials({ roleArn: o["role-arn"], externalId: o["external-id"], sessionName: "tech-audit", baseCredentials: base, endpoint })
            : base;
          result = await runTechAudit({ ...common, credentials });
        }
      } catch (err) {
        fail(`Tech audit failed: ${(err as Error).message}`);
      }
      if (o.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        for (const v of VERDICT_ORDER) {
          const n = result.results.filter((r) => r.result.verdict === v).length;
          if (n) process.stdout.write(`${v.padEnd(8)} ${n}\n`);
        }
      }
      if (o.out) {
        const dir = resolve(o.out);
        await mkdir(dir, { recursive: true });
        const stem = join(dir, `tech-audit-${result.accountId}-${result.finishedAt.slice(0, 10)}`);
        await writeFile(`${stem}.csv`, toTechAuditCsv(result));
        await writeFile(`${stem}.md`, toTechAuditMarkdown(result, o.client ? `Engg Tech Audit (AWS checks): ${o.client} (${result.accountId})` : undefined));
        process.stderr.write(`Wrote ${stem}.csv and ${stem}.md\n`);
        if (result.eol) {
          const eolStem = join(dir, `eol-${result.accountId}-${result.eol.finishedAt.slice(0, 10)}`);
          await writeFile(`${eolStem}.csv`, toCsv(result.eol));
          await writeFile(`${eolStem}.md`, toMarkdown(result.eol, o.client ? `EOL audit: ${o.client} (${result.accountId})` : undefined));
          process.stderr.write(`Wrote ${eolStem}.csv and ${eolStem}.md\n`);
        }
      }
      return result.results.some((r) => r.result.verdict === "FAIL") ? 1 : 0;
    }

    case "invite": {
      if (!o.name) fail("--name is required");
      let ours = o["our-account-id"];
      if (!ours) {
        try {
          ours = (await callerAccountId({ credentials: base, endpoint })).account;
        } catch (err) {
          fail(`Cannot read our AWS identity (${(err as Error).message}); log in or pass --our-account-id`);
        }
      }
      try {
        const { connection, parameters } = await createInvite(store, {
          name: o.name, trustedAccountId: ours, principalArn: o["principal-arn"], regions: list(o.regions), rotate: o.rotate,
        });
        process.stdout.write(`Client '${connection.name}' registered in ${store.path}\n\n`
          + `Send the client CLIENT_SETUP.md, the template, and these values (none are secrets):\n\n`
          + `  Template:            ${TEMPLATE_PATH}\n`
          + Object.entries(parameters).map(([k, v]) => `  ${(k + ":").padEnd(20)} ${v}`).join("\n") + "\n");
        if (o["template-url"]) {
          process.stdout.write(`\nOne-click setup link:\n\n  ${quickCreateUrl({
            templateUrl: o["template-url"], region: o["console-region"] ?? "eu-west-2", parameters,
          })}\n`);
        }
        process.stdout.write(`\nWhen they send back the stack's RoleArn output:\n  aws-eol-audit verify --name ${connection.name} --role-arn <RoleArn>\n`);
      } catch (err) {
        fail((err as Error).message);
      }
      return 0;
    }

    case "verify": {
      if (!o.name || !o["role-arn"]) fail("--name and --role-arn are required");
      try {
        const conn = await verifyConnection(store, { name: o.name, roleArn: o["role-arn"], baseCredentials: base, endpoint });
        process.stdout.write(`Connected '${conn.name}' (account ${conn.accountId}).\n`
          + `Audit any time with:\n  aws-eol-audit audit --client ${conn.name}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`Could not assume the role: ${(err as Error).message}\n\n`
          + "Check the client used the TrustedAccountId and ExternalId from the invite, and that you are "
          + "authenticated as that account (--profile).\n");
        return 1;
      }
    }

    case "list": {
      const all = await store.list();
      if (!all.length) {
        process.stdout.write("No clients registered.\n");
        return 0;
      }
      process.stdout.write(`${"NAME".padEnd(20)} ${"ACCOUNT".padEnd(14)} ${"STATUS".padEnd(10)} ${"VERIFIED".padEnd(25)} REGIONS\n`);
      for (const c of all) {
        process.stdout.write(`${c.name.padEnd(20)} ${(c.accountId ?? "-").padEnd(14)} `
          + `${(c.roleArn ? "connected" : "invited").padEnd(10)} ${(c.verifiedAt ?? "-").padEnd(25)} `
          + `${c.regions?.join(" ") || "all enabled"}\n`);
      }
      return 0;
    }

    case "remove": {
      if (!o.name) fail("--name is required");
      if (!(await store.delete(o.name))) fail(`Unknown client '${o.name}'`);
      process.stdout.write(`Removed '${o.name}' locally. Ask the client to delete the '${STACK_NAME}' stack to revoke access.\n`);
      return 0;
    }

    default:
      fail(`Unknown command '${cmd}'\n\n${USAGE}`);
  }
}

main().then((code) => process.exit(code), (err) => fail(`Unexpected error: ${(err as Error).stack ?? err}`));
