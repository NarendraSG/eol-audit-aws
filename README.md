# @studiographene/aws-eol-audit

Read-only inventory of versioned AWS components (Lambda runtimes, RDS/Aurora/DocumentDB,
ElastiCache, OpenSearch, EKS, MSK, Amazon MQ, EC2 OS, ECS image tags, optionally SSM-inventoried
Node.js/Python), checked against [endoflife.date](https://endoflife.date). Includes OAuth-style
cross-account onboarding so a client grants access once and you audit on demand, with no keys shared.

Library first (use it from any Node 20+ service, Lambda, or SST app), with a CLI on top.

## Install

From a git repository or a monorepo workspace (the package is `private`; publish to your
registry by removing `"private": true` first):

```bash
npm install git+ssh://git@github.com/<org>/aws-eol-audit.git
```

```bash
npm install ../aws-eol-audit-ts
```

## How delegated access works

| OAuth 2.0 | This module |
|---|---|
| App registration | Your AWS account ID, trusted by the client's role |
| Binding request to one client | Per-client external ID (`createInvite`) |
| Consent screen | Client deploys `templates/eol-audit-readonly-role.yaml` once |
| Scopes | Role policy: only the describe/list calls the audit makes |
| Refresh token | Your own AWS identity (SSO, IAM role of the host) |
| Access token | 1-hour STS credentials, auto-renewed (`assumeRoleCredentials`) |
| Revoke | Client deletes the stack |

## Library usage

### Audit an account you already have credentials for

```ts
import { runAudit, toMarkdown } from "@studiographene/aws-eol-audit";

const result = await runAudit({ regions: ["eu-west-2", "us-east-1"] });
console.log(result.summary);          // { EOL: 1, DEPRECATED: 2, OK: 40, ... }
const markdown = toMarkdown(result);
```

### Onboard a client and audit them on demand

```ts
import {
  createInvite, verifyConnection, auditClient, FileConnectionStore, quickCreateUrl,
} from "@studiographene/aws-eol-audit";

const store = new FileConnectionStore("./clients.json");

// 1. One-time: generate the client's setup values.
const { parameters } = await createInvite(store, {
  name: "acme", trustedAccountId: "111111111111", regions: ["eu-west-2"],
});
// Optional one-click link (template hosted in S3):
const link = quickCreateUrl({ templateUrl: "https://<bucket>.s3.eu-west-2.amazonaws.com/eol-audit-readonly-role.yaml",
  region: "eu-west-2", parameters });

// 2. One-time: after the client returns the stack's RoleArn output.
await verifyConnection(store, { name: "acme", roleArn: "arn:aws:iam::222222222222:role/eol-audit-readonly" });

// 3. Any time.
const result = await auditClient(store, "acme");
```

### Store connections in your own database

Implement `ConnectionStore` (four async methods) over Postgres, DynamoDB, etc.:

```ts
import type { ClientConnection, ConnectionStore } from "@studiographene/aws-eol-audit";

class PrismaConnectionStore implements ConnectionStore {
  get(name: string) { /* select ... where name = $1 */ }
  put(conn: ClientConnection) { /* upsert */ }
  delete(name: string) { /* delete, return true if a row was removed */ }
  list() { /* select all, ordered by name */ }
}
```

### Other building blocks

| Export | Use |
|---|---|
| `assumeRoleCredentials({ roleArn, externalId, baseCredentials })` | Auto-refreshing credentials for any AWS SDK v3 client |
| `COLLECTORS.lambda(ctx)` etc. | Run a single collector |
| `EolClient`, `classify`, `matchCycle` | EOL lookup only, e.g. for versions found in IaC or package.json |
| `toCsv`, `toMarkdown` | Reports (CSV cells are guarded against formula injection) |
| `TEMPLATE_PATH`, `@studiographene/aws-eol-audit/template` | The CloudFormation template to send to clients |

`runAudit` never throws for a single failing service: `AccessDenied` and similar come back in
`result.errors`. It throws only for invalid options or unusable credentials.

## CLI

```bash
npx aws-eol-audit invite --name acme --profile <our-profile> --regions eu-west-2,us-east-1
```

```bash
npx aws-eol-audit verify --name acme --role-arn arn:aws:iam::<CLIENT_ACCOUNT>:role/eol-audit-readonly --profile <our-profile>
```

```bash
npx aws-eol-audit audit --client acme --profile <our-profile> --out reports/acme
```

Also: `audit` with your own credentials (no `--client`), `audit --role-arn ... --external-id ...`,
`--json`, `--services lambda,rds`, `--ssm`, `--warn-days 90`, `list`, `remove`,
`invite --rotate`. Store location: `--store` or `AWS_EOL_AUDIT_STORE` (default `./clients.json`).
Exit codes: 0 ok, 1 something past EOL (useful as a CI gate), 2 usage or auth error.

## Engg Tech Audit (AWS checks)

```bash
npx aws-eol-audit tech-audit --client acme --profile <our-profile> --out reports/acme
```

Answers the 19 questions of the Engg Tech Audit (Project Audit 4.0) that AWS can speak to, each
with a verdict (`PASS`, `FAIL`, `REVIEW`, `N/A`, `UNKNOWN`) and the evidence behind it. The Markdown
report ends with a coverage section (fully and partially answerable questions, with this run's
evidence) and an appendix listing what each check looked at and the permissions it needs. Options:
`--only IS.6,IS.13`, `--regions`, `--json`, and `--sample-logs` for IS. 8 (the client must deploy the
role with `AllowLogSampling=true`). Also available as `runTechAudit` and `techAuditClient`. Exit code 1
when any question is `FAIL`. See `docs/TECH_AUDIT_COVERAGE.md`. Clients onboarded earlier must update
their stack to the current template, otherwise the new checks report `UNKNOWN`.

## Security notes

- **Our side:** the identity that runs audits needs only `sts:AssumeRole` on
  `arn:aws:iam::*:role/eol-audit-readonly`. Pass `principalArn` to `createInvite` so a client's
  role trusts only that specific role of ours, not our whole account.
- **Client side:** the role has no data access (S3, databases, secrets, logs). Note that
  `lambda:ListFunctions` and `ecs:DescribeTaskDefinition` responses include environment
  variables; this module reads only version fields and never stores them.
- **External ID:** not a secret, but unique per client. Never reuse one across clients.
- **Connection store:** holds role ARNs and external IDs, no credentials. It still identifies
  client accounts: keep it access-controlled and out of git.
- Get each client's approval in writing before onboarding them.

## Development

```bash
npm install && npm run typecheck && npm test && npm run build
```
