import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@smithy/types";

export const ROLE_ARN_RE = /^arn:aws[\w-]*:iam::(\d{12}):role\/[\w+=,.@/-]+$/;
const EXTERNAL_ID_RE = /^[\w+=,.@:/-]{2,1224}$/;
const SESSION_NAME_RE = /^[\w+=,.@-]{2,64}$/;

export interface AssumeRoleOptions {
  roleArn: string;
  externalId?: string;
  sessionName?: string;
  /** 900-3600. Role chaining (e.g. from an SSO role) caps this at 3600. */
  durationSeconds?: number;
  /** Our own identity. Defaults to the SDK's default provider chain. */
  baseCredentials?: AwsCredentialIdentityProvider;
  /** Region for the STS call. */
  region?: string;
  endpoint?: string;
}

export function accountIdFromRoleArn(roleArn: string): string {
  const m = ROLE_ARN_RE.exec(roleArn);
  if (!m?.[1]) throw new Error(`Invalid role ARN: ${roleArn}`);
  return m[1];
}

/**
 * Credentials for a client's read-only role. The returned provider caches short-lived STS
 * credentials and re-assumes the role when they near expiry, so long audits keep working.
 */
export function assumeRoleCredentials(opts: AssumeRoleOptions): AwsCredentialIdentityProvider {
  accountIdFromRoleArn(opts.roleArn); // validates
  if (opts.externalId !== undefined && !EXTERNAL_ID_RE.test(opts.externalId)) {
    throw new Error("externalId contains invalid characters or has an invalid length");
  }
  const sessionName = opts.sessionName ?? "eol-audit";
  if (!SESSION_NAME_RE.test(sessionName)) throw new Error(`Invalid session name: ${sessionName}`);
  const duration = opts.durationSeconds ?? 3600;
  if (!Number.isInteger(duration) || duration < 900 || duration > 43_200) {
    throw new Error("durationSeconds must be an integer between 900 and 43200");
  }

  return fromTemporaryCredentials({
    masterCredentials: opts.baseCredentials,
    params: {
      RoleArn: opts.roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: duration,
      ...(opts.externalId ? { ExternalId: opts.externalId } : {}),
    },
    clientConfig: { region: opts.region ?? "us-east-1", ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) },
  });
}
