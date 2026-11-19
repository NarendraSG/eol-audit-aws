# Granting read-only access for the end-of-life audit

This one-off setup lets our audit tool check which software versions your AWS resources run
(for example Lambda runtimes, database engine versions and Kubernetes versions) so we can tell
you what is out of support and what needs upgrading.

It takes about five minutes and needs someone who can create IAM roles in your account.

## What you are granting

- A single IAM role, `eol-audit-readonly`, that only our AWS account can use, and only when it
  presents a unique ID we have generated for you (the "external ID").
- Permission to **list and describe** resources: names, types and version numbers.
- **No access to your data**: the role cannot read S3 objects, database contents, secrets,
  parameters or logs, and cannot change anything.
- Short-lived credentials only (one hour at a time). No access keys are created or shared.
- Every action the role takes is recorded in your AWS CloudTrail.

Please note: some describe calls return configuration that may include environment
variables (Lambda functions and ECS task definitions). Our tool reads only the version
fields and does not store these, but if your environment variables contain plain-text
secrets we recommend moving them to AWS Secrets Manager regardless.

## Setup

We will send you three values: our **AWS account ID**, your **external ID**, and (optionally) a
one-click setup link.

**With the link:** open it while signed in to the right AWS account, tick
"I acknowledge that AWS CloudFormation might create IAM resources with custom names", and
choose **Create stack**.

**Without the link:**

1. Open **CloudFormation** in the AWS console (any region; IAM roles are global).
2. Choose **Create stack**, then **With new resources (standard)**.
3. Choose **Upload a template file** and select `eol-audit-readonly-role.yaml` (sent by us).
4. Stack name: `eol-audit-readonly`.
5. Enter the `TrustedAccountId` and `ExternalId` we sent you. Leave the other fields as they are.
6. Tick the IAM acknowledgement box and choose **Create stack**.

When the stack shows `CREATE_COMPLETE`, open its **Outputs** tab and send us the
**RoleArn** value. That is all we need.

If you use AWS Organizations and would like us to audit several accounts, the same template
can be deployed to all of them with a CloudFormation StackSet.

## Removing access

Delete the `eol-audit-readonly` stack. No new sessions can start after that, and any session
already in progress expires within an hour at most.
