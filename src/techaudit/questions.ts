import type { Question } from "./types.js";

/** Questionnaire size, and the questions that cannot be answered from AWS. Mirrors the coverage doc. */
export const QUESTIONNAIRE_TOTAL = 69;
export const NOT_FROM_AWS =
  "TD. 1, 2, 6, 7, 8; PP. 1, 3 to 10; EG. 1 to 20 and 22; IS. 1, 9, 14, 15, 18, 21, 22; all TM. and DM. "
  + "questions. These need GitHub, Jira, Pulse, Confluence, the codebase or team interviews.";

const TD = "Technical Design", IS = "Information Security", EG = "Engg Guidelines";

function q(sec: string, group: string, name: string, traceability: string, coverage: "Full" | "Partial",
  scope: string, permissions: string, stillToConfirm = ""): Question {
  return { sec, group, name, traceability, coverage, stillToConfirm, scope, permissions };
}

/** Order and wording from Project Audit 4.0. Keep scope/permissions in step with the role template. */
export const QUESTIONS: readonly Question[] = [
  q("TD. 3", TD, "Is VPC created as (PROJECTNAME_ENV) with related resources, instead of using a default VPC?",
    "v1.0 - Project Setup", "Full",
    "VPC `Name` tags against the `PROJECT_ENV` pattern; EC2 instances, RDS databases and Lambda functions placed in a default VPC",
    "ec2:DescribeVpcs"),
  q("TD. 4", TD, "Is CI/CD implemented using AWS CodeBuild (CI) and AWS CodePipelines (CD)?",
    "v1.0 - Cloud orchestration", "Full",
    "CodeBuild projects and CodePipeline pipelines per region", "codebuild:ListProjects, codepipeline:ListPipelines"),
  q("TD. 5", TD, "Is the server instance part of the autoscaling group?", "v1.0 - Cloud orchestration", "Full",
    "Running EC2 instances not in an Auto Scaling group; ECS services with and without auto-scaling targets",
    "autoscaling:DescribeAutoScalingInstances, application-autoscaling:DescribeScalableTargets"),
  q("IS. 2", IS, "(R) Do no users with admin access have CLI enabled?", "", "Full",
    "IAM users with `AdministratorAccess` (directly or through a group) that have an active access key",
    "iam:GetCredentialReport, iam:ListEntitiesForPolicy, iam:GetGroup"),
  q("IS. 3", IS, "Are AWS access keys avoided, and only role-based access is available?", "", "Full",
    "IAM credential report: users with active access keys and when the keys were last used",
    "iam:GenerateCredentialReport, iam:GetCredentialReport"),
  q("IS. 4", IS, "Do no team members have AWS root access?", "", "Partial",
    "Root user access keys, MFA status, last password use", "iam:GetCredentialReport", "Who holds the root password"),
  q("IS. 5", IS, "(R) Do AWS users have MFA enabled?", "", "Partial",
    "IAM users with console passwords but no MFA", "iam:GetCredentialReport",
    "MFA for SSO (Identity Center) users, set in the management account"),
  q("IS. 6", IS, "Does the Database have no public accessibility?", "", "Full",
    "RDS `PubliclyAccessible` flag; database security groups open to `0.0.0.0/0` or `::/0`",
    "ec2:DescribeSecurityGroups"),
  q("IS. 7", IS, "Is AWS CloudWatch configured to analyse application logs (BE, FE & Mobile) and metrics maintained?",
    "", "Partial", "Log groups, retention settings, stored volume", "logs:DescribeLogGroups",
    "Front-end and mobile logging, usually in other tools"),
  q("IS. 8", IS, "Are logs over AWS CloudWatch in proper JSON format with proper log level & contain tags like requestId, source, userInfo, etc?",
    "Project Monitoring", "Partial",
    "Only with opt-in log sampling: share of sampled lines that are JSON and carry a level and request ID (log content is never stored)",
    "logs:FilterLogEvents (opt-in, reads log content)", "Without opt-in sampling: review log samples by hand"),
  q("IS. 10", IS, "Is uptime monitoring enabled?", "Project Monitoring", "Partial",
    "CloudWatch Synthetics canaries, Route 53 health checks", "synthetics:DescribeCanaries, route53:ListHealthChecks",
    "External uptime tools"),
  q("IS. 11", IS, "Are scheduled backups properly configured?", "", "Full",
    "RDS backup retention period; AWS Backup plans; DynamoDB point-in-time recovery",
    "backup:ListBackupPlans, dynamodb:ListTables, dynamodb:DescribeContinuousBackups"),
  q("IS. 12", IS, "Are AWS CloudWatch alarms enabled?", "", "Full",
    "CloudWatch alarms per region, how many have notification actions, how many are in `ALARM`",
    "cloudwatch:DescribeAlarms"),
  q("IS. 13", IS, "Is the database encrypted using a custom KMS key as recommended (if applicable)?",
    "Project Monitoring", "Full",
    "RDS storage encryption and whether the KMS key is customer-managed or AWS-managed", "kms:DescribeKey"),
  q("IS. 16", IS, "(R) Are none of the language versions and packages reaching end-of-life in any of the repos?",
    "", "Partial", "EOL status of Lambda runtimes, database engines, caches, EKS, OS, container base images",
    "EOL audit permissions (eol-audit-list-metadata)", "Package and language versions inside the repos"),
  q("IS. 17", IS, "(R) Is access to the production environment available to the limited team members, and are AWS and GitHub/Bitbucket monitored for cost optimisation?",
    "v1.0 - CI Checks", "Partial",
    "Users, groups and roles with `AdministratorAccess`; AWS Budgets; last 3 months' spend",
    "iam:ListEntitiesForPolicy, budgets:ViewBudget, ce:GetCostAndUsage (USD 0.01 per run)",
    "SSO access assignments (management account), GitHub/Bitbucket costs"),
  q("IS. 19", IS, "(R) GDPR: User/PII data is not stored in common storage or the device's local filesystem in an unencrypted form. Is the production data properly sanitised if copied into any of the lower environments?",
    "", "Partial", "S3 bucket default encryption and public access block; whether Amazon Macie is enabled",
    "s3:ListAllMyBuckets, s3:GetEncryptionConfiguration, s3:GetBucketPublicAccessBlock, macie2:GetMacieSession",
    "Device storage, and sanitisation of data copied to lower environments"),
  q("IS. 20", IS, "(R) GDPR: Is the User/PII/Financial data stored securely and not part of the data getting logged?",
    "Project Closure", "Partial",
    "Encryption at rest (RDS, S3); log groups with a data protection (masking) policy; Macie enabled",
    "logs:DescribeLogGroups, s3:GetEncryptionConfiguration, macie2:GetMacieSession",
    "That personal data is actually absent from logs"),
  q("EG. 21", EG, "Is New Relic/APM/Traces/AWS X-Ray being used to identify bottlenecks in live projects?",
    "Project Monitoring", "Partial",
    "X-Ray tracing on Lambda and API Gateway stages; New Relic, Datadog or OpenTelemetry layers and sidecars",
    "apigateway:GET (REST API and stage settings only)", "That the team actually uses the tooling to find bottlenecks"),
];

export const normaliseSec = (s: string): string => s.replace(/\s+/g, "").toUpperCase();
