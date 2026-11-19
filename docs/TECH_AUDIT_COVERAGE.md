# Engg Tech Audit Questionnaire: AWS coverage

Source: Confluence, *Engg Tech Audit Questionnaire*, section **Project Audit 4.0** (69 questions).

This write-up lists the questions that can be answered from a client's AWS account through the
read-only delegated role (see `CLIENT_SETUP.md`), what evidence `aws-eol-audit tech-audit` collects for
each, and what still has to be confirmed by a person. The remaining 50 questions concern
process, Jira, QA, GitHub or code, and cannot be answered from AWS.

**Summary: 19 of 69 questions. 9 fully answerable, 10 partially answerable.**

## How to read the report

`aws-eol-audit tech-audit` gives each question one verdict:

| Verdict | Meaning |
|---|---|
| `PASS` | AWS evidence meets the expectation |
| `FAIL` | AWS evidence shows a gap (listed in the evidence column) |
| `REVIEW` | Evidence collected, but a person must judge it (typical for partial questions) |
| `N/A` | Nothing to assess, e.g. no databases in the account |
| `UNKNOWN` | The check could not run, usually a missing permission or an unsupported region |

For partially answerable questions, a `PASS` only covers the AWS side. The "Still to confirm"
column says what the auditor must check elsewhere.

## Fully answerable

| Sec. # | Group name | Name | Traceability | AWS evidence collected |
|---|---|---|---|---|
| TD. 3 | Technical Design | Is VPC created as (PROJECTNAME_ENV) with related resources, instead of using a default VPC? | v1.0 - Project Setup | VPC `Name` tags against the `PROJECT_ENV` pattern; EC2 instances, RDS databases and Lambda functions placed in a default VPC |
| TD. 4 | Technical Design | Is CI/CD implemented using AWS CodeBuild (CI) and AWS CodePipelines (CD)? | v1.0 - Cloud orchestration | CodeBuild projects and CodePipeline pipelines per region |
| TD. 5 | Technical Design | Is the server instance part of the autoscaling group? | v1.0 - Cloud orchestration | Running EC2 instances not in an Auto Scaling group; ECS services with and without auto-scaling targets |
| IS. 2 | Information Security | (R) Do no users with admin access have CLI enabled? | None listed | IAM users with `AdministratorAccess` (directly or through a group) that have an active access key |
| IS. 3 | Information Security | Are AWS access keys avoided, and only role-based access is available? | None listed | IAM credential report: users with active access keys and when the keys were last used |
| IS. 6 | Information Security | Does the Database have no public accessibility? | None listed | RDS `PubliclyAccessible` flag; database security groups open to `0.0.0.0/0` or `::/0` |
| IS. 11 | Information Security | Are scheduled backups properly configured? | None listed | RDS backup retention period; AWS Backup plans; DynamoDB point-in-time recovery |
| IS. 12 | Information Security | Are AWS CloudWatch alarms enabled? | None listed | CloudWatch alarms per region, how many have notification actions, how many are in `ALARM` |
| IS. 13 | Information Security | Is the database encrypted using a custom KMS key as recommended (if applicable)? | Project Monitoring | RDS storage encryption and whether the KMS key is customer-managed or AWS-managed |

## Partially answerable

| Sec. # | Group name | Name | Traceability | AWS evidence collected | Still to confirm |
|---|---|---|---|---|---|
| IS. 4 | Information Security | Do no team members have AWS root access? | None listed | Root user access keys, MFA status, last password use | Who holds the root password |
| IS. 5 | Information Security | (R) Do AWS users have MFA enabled? | None listed | IAM users with console passwords but no MFA | MFA for SSO (Identity Center) users, which is set in the management account |
| IS. 7 | Information Security | Is AWS CloudWatch configured to analyse application logs (BE, FE & Mobile) and metrics maintained? | None listed | Log groups, retention settings, stored volume | Front-end and mobile logging, usually in other tools |
| IS. 8 | Information Security | Are logs over AWS CloudWatch in proper JSON format with proper log level & contain tags like requestId, source, userInfo, etc? | Project Monitoring | Only with opt-in log sampling: share of sampled lines that are JSON and carry a level and request ID (log content is never stored) | Without opt-in: review log samples by hand |
| IS. 10 | Information Security | Is uptime monitoring enabled? | Project Monitoring | CloudWatch Synthetics canaries, Route 53 health checks | External uptime tools |
| IS. 16 | Information Security | (R) Are none of the language versions and packages reaching end-of-life in any of the repos? | None listed | EOL status of Lambda runtimes, database engines, caches, EKS, OS, container base images | Package and language versions inside the repos |
| IS. 17 | Information Security | (R) Is access to the production environment available to the limited team members, and are AWS and GitHub/Bitbucket monitored for cost optimisation? | v1.0 - CI Checks | Users, groups and roles with `AdministratorAccess`; AWS Budgets; last 3 months' spend | SSO access assignments (management account), GitHub/Bitbucket costs |
| IS. 19 | Information Security | (R) GDPR: User/PII data is not stored in common storage or the device's local filesystem in an unencrypted form. Is the production data properly sanitised if copied into any of the lower environments? | None listed | S3 bucket default encryption and public access block; whether Amazon Macie is enabled | Device storage, and sanitisation of data copied to lower environments |
| IS. 20 | Information Security | (R) GDPR: Is the User/PII/Financial data stored securely and not part of the data getting logged? | Project Closure | Encryption at rest (RDS, S3); log groups with a data protection (masking) policy; Macie enabled | That personal data is actually absent from logs |
| EG. 21 | Engg Guidelines | Is New Relic/APM/Traces/AWS X-Ray being used to identify bottlenecks in live projects? | Project Monitoring | X-Ray tracing on Lambda and API Gateway stages; New Relic, Datadog or OpenTelemetry layers and sidecars | That the team actually uses the tooling to find bottlenecks |

## Change plan

| # | Change | Files | Status |
|---|---|---|---|
| 1 | Add the read-only actions each new check needs to the client role, as a separate policy (`tech-audit-list-configuration`) so the EOL-only scope stays visible | `templates/eol-audit-readonly-role.yaml` | Done; passes `cfn-lint` |
| 2 | Add an opt-in `AllowLogSampling` template parameter that grants `logs:FilterLogEvents`, used only for IS. 8 | `templates/eol-audit-readonly-role.yaml` | Done; defaults to `false` |
| 3 | New `aws-eol-audit tech-audit`: one check per question above, verdicts, evidence, Markdown and CSV report; reuses client onboarding and assume-role from `aws-eol-audit audit` | `aws-eol-audit tech-audit` | Done |
| 4 | Each check fails safe: a denied or unsupported call gives `UNKNOWN` with the reason, and never stops the run | `aws-eol-audit tech-audit` | Done |
| 5 | Test every check against a mocked AWS account seeded with passing and failing resources | test harness (not shipped) | Done; see "Test results" |
| 6 | Document how to run it and what the client is agreeing to | `README.md`, `CLIENT_SETUP.md`, this file | Done |

### Test results (mocked AWS, 2026-11-19)

Run against a local mock (moto) of a client account, through the full onboarding flow
(`invite`, `verify`, then `tech_audit.py --client`). The account was seeded with deliberate
problems; each was reported with the right verdict and evidence:

| Seeded condition | Question | Verdict |
|---|---|---|
| EC2 instance in the default VPC; a VPC named `random-vpc` | TD. 3 | FAIL |
| No CodeBuild or CodePipeline | TD. 4 | FAIL |
| EC2 instance outside an Auto Scaling group | TD. 5 | FAIL |
| Admin IAM user with an access key | IS. 2, IS. 3 | FAIL |
| Console user without MFA | IS. 5 | FAIL |
| Public Postgres with a security group open on 5432 | IS. 6 | FAIL |
| Database with backups off; DynamoDB without point-in-time recovery | IS. 11 | FAIL |
| Alarm with no notification action | IS. 12 | FAIL |
| Unencrypted database | IS. 13, IS. 20 | FAIL |
| Lambda on `nodejs16.x`, Postgres 13 | IS. 16 | FAIL |
| S3 bucket without encryption or public access block | IS. 19 | FAIL |
| Log group: one JSON line with level and request ID, one plain line | IS. 8 | REVIEW (50%) |
| Route 53 health check | IS. 10 | PASS |
| Lambda with X-Ray active tracing | EG. 21 | PASS |

Not proven by the mock:

- **Permission enforcement:** moto does not enforce IAM, so `UNKNOWN` for missing
  permissions has not been seen against real AWS.
- **IS. 4:** moto's credential report has no root row, so IS. 4 showed `UNKNOWN`. Real AWS
  always includes it.
- **Real data volume:** first real run should be on one of our own non-production accounts.

## Permissions added to the client role

All metadata-only, except where noted.

| Question | Actions |
|---|---|
| TD. 3 | `ec2:DescribeVpcs` (instances, RDS and Lambda already covered) |
| TD. 4 | `codebuild:ListProjects`, `codepipeline:ListPipelines` |
| TD. 5 | `autoscaling:DescribeAutoScalingInstances`, `application-autoscaling:DescribeScalableTargets` |
| IS. 2, 3, 4, 5, 17 | `iam:GenerateCredentialReport`, `iam:GetCredentialReport`, `iam:ListEntitiesForPolicy`, `iam:GetGroup` |
| IS. 6 | `ec2:DescribeSecurityGroups` |
| IS. 7, 20 | `logs:DescribeLogGroups` |
| IS. 8 (opt-in) | `logs:FilterLogEvents`: **reads log content**; only granted if the client sets `AllowLogSampling=true` |
| IS. 10 | `synthetics:DescribeCanaries`, `route53:ListHealthChecks` |
| IS. 11 | `backup:ListBackupPlans`, `dynamodb:ListTables`, `dynamodb:DescribeContinuousBackups` |
| IS. 12 | `cloudwatch:DescribeAlarms` |
| IS. 13 | `kms:DescribeKey` |
| IS. 17 | `budgets:ViewBudget`, `ce:GetCostAndUsage` |
| IS. 19, 20 | `s3:ListAllMyBuckets`, `s3:GetEncryptionConfiguration`, `s3:GetBucketPublicAccessBlock`, `macie2:GetMacieSession` |
| EG. 21 | `apigateway:GET` (REST API and stage settings only) |

Notes:

- **Cost:** each Cost Explorer `GetCostAndUsage` request costs USD 0.01 at AWS list price. The
  tool makes one per run.
- **IAM data:** the credential report lists IAM user names and key and MFA status, but no
  secrets. Treat reports as client-confidential.

## Not answerable from AWS

TD. 1, 2, 6, 7, 8; PP. 1, 3 to 10; EG. 1 to 20 and 22 (except EG. 21); IS. 1, 9, 14, 15, 18,
21, 22; all TM. and DM. questions. These need GitHub, Jira, Pulse, Confluence, the codebase or
team interviews. IS. 9 (SSLreminder on Slack) and TM. 2 (QA/UAT environment availability) have
only indirect AWS signals, such as ACM certificate expiry dates and environment tags, so they
are not counted.
