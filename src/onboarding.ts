import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { runAudit, callerAccountId, type AuditOptions } from "./audit.js";
import { accountIdFromRoleArn, assumeRoleCredentials } from "./credentials.js";
import { runTechAudit } from "./techaudit/run.js";
import type { TechAuditOptions, TechAuditResult } from "./techaudit/types.js";
import type { AuditResult } from "./types.js";

/**
 * OAuth-style delegated access, AWS edition:
 *   createInvite      -> per-client external ID + setup parameters ("consent request")
 *   client deploys the CloudFormation template once ("consent")
 *   verifyConnection  -> records the role ARN after proving it can be assumed
 *   auditClient       -> any time later, assume the role and run the audit
 */

export const TEMPLATE_PATH = fileURLToPath(new URL("../templates/eol-audit-readonly-role.yaml", import.meta.url));
export const STACK_NAME = "eol-audit-readonly";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ACCOUNT_RE = /^\d{12}$/;

export interface ClientConnection {
  name: string;
  /** Not a secret, but unique per client: it binds the client's role to this connection. */
  externalId: string;
  /** Our AWS account the client's role trusts. */
  trustedAccountId: string;
  /** Optional: only this principal (ARN or pattern) of ours may assume the role. */
  principalArn?: string;
  /** Default regions to audit; empty means all enabled regions. */
  regions?: string[];
  invitedAt: string;
  roleArn?: string;
  accountId?: string;
  verifiedAt?: string;
}

/** Where connections live. Implement this over your database to integrate with an app. */
export interface ConnectionStore {
  get(name: string): Promise<ClientConnection | undefined>;
  put(conn: ClientConnection): Promise<void>;
  delete(name: string): Promise<boolean>;
  list(): Promise<ClientConnection[]>;
}

export class MemoryConnectionStore implements ConnectionStore {
  private readonly items = new Map<string, ClientConnection>();
  async get(name: string) { return this.items.get(name); }
  async put(conn: ClientConnection) { this.items.set(conn.name, { ...conn }); }
  async delete(name: string) { return this.items.delete(name); }
  async list() { return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name)); }
}

/** JSON file store (mode 0600, atomic writes). Suitable for a CLI or a single host. */
export class FileConnectionStore implements ConnectionStore {
  constructor(readonly path: string) {}

  private async read(): Promise<Record<string, ClientConnection>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const parsed = JSON.parse(raw) as { clients?: Record<string, ClientConnection> };
    if (typeof parsed !== "object" || parsed === null) throw new Error(`${this.path}: not a JSON object`);
    return parsed.clients ?? {};
  }

  private async write(clients: Record<string, ClientConnection>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ clients }, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  async get(name: string) { return (await this.read())[name]; }
  async put(conn: ClientConnection) {
    const all = await this.read();
    all[conn.name] = conn;
    await this.write(all);
  }
  async delete(name: string) {
    const all = await this.read();
    if (!(name in all)) return false;
    delete all[name];
    await this.write(all);
    return true;
  }
  async list() { return Object.values(await this.read()).sort((a, b) => a.name.localeCompare(b.name)); }
}

export function generateExternalId(): string {
  return randomBytes(20).toString("hex");
}

export interface StackParameters {
  TrustedAccountId: string;
  ExternalId: string;
  TrustedPrincipalArn?: string;
}

/** One-click CloudFormation link. The template must be hosted at an S3 HTTPS URL. */
export function quickCreateUrl(opts: { templateUrl: string; region: string; parameters: StackParameters; stackName?: string }): string {
  if (!/^https:\/\/[\w.-]+\.amazonaws\.com\//.test(opts.templateUrl)) {
    throw new Error("templateUrl must be an https://...amazonaws.com/ (S3) URL");
  }
  if (!/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(opts.region)) throw new Error(`Invalid region: ${opts.region}`);
  const q = new URLSearchParams({ templateURL: opts.templateUrl, stackName: opts.stackName ?? STACK_NAME });
  for (const [k, v] of Object.entries(opts.parameters)) if (v) q.set(`param_${k}`, v);
  return `https://${opts.region}.console.aws.amazon.com/cloudformation/home?region=${opts.region}#/stacks/create/review?${q}`;
}

export interface InviteOptions {
  name: string;
  trustedAccountId: string;
  principalArn?: string;
  regions?: string[];
  /** Issue a new external ID even if the client is connected (they must update their stack). */
  rotate?: boolean;
}

export async function createInvite(store: ConnectionStore, opts: InviteOptions): Promise<{ connection: ClientConnection; parameters: StackParameters }> {
  if (!NAME_RE.test(opts.name)) throw new Error("name must be 2-41 chars: lowercase letters, digits, hyphens");
  if (!ACCOUNT_RE.test(opts.trustedAccountId)) throw new Error("trustedAccountId must be 12 digits");

  const existing = await store.get(opts.name);
  if (existing?.roleArn && !opts.rotate) {
    throw new Error(`'${opts.name}' is already connected; pass rotate to issue a new external ID`);
  }
  const conn: ClientConnection = {
    ...existing,
    name: opts.name,
    externalId: existing?.externalId && !opts.rotate ? existing.externalId : generateExternalId(),
    trustedAccountId: opts.trustedAccountId,
    invitedAt: new Date().toISOString(),
    ...(opts.principalArn !== undefined ? { principalArn: opts.principalArn } : {}),
    ...(opts.regions ? { regions: opts.regions } : {}),
  };
  if (opts.rotate) {
    delete conn.roleArn;
    delete conn.accountId;
    delete conn.verifiedAt;
  }
  await store.put(conn);
  return {
    connection: conn,
    parameters: {
      TrustedAccountId: conn.trustedAccountId,
      ExternalId: conn.externalId,
      ...(conn.principalArn ? { TrustedPrincipalArn: conn.principalArn } : {}),
    },
  };
}

export interface VerifyOptions {
  name: string;
  roleArn: string;
  /** Our own identity used to assume the role. Defaults to the SDK provider chain. */
  baseCredentials?: AwsCredentialIdentityProvider;
  endpoint?: string;
}

/** Proves the client's role can be assumed with this connection's external ID, then records it. */
export async function verifyConnection(store: ConnectionStore, opts: VerifyOptions): Promise<ClientConnection> {
  const conn = await store.get(opts.name);
  if (!conn) throw new Error(`Unknown client '${opts.name}'; create an invite first`);
  const expected = accountIdFromRoleArn(opts.roleArn);
  const credentials = assumeRoleCredentials({
    roleArn: opts.roleArn, externalId: conn.externalId, sessionName: "eol-audit-verify",
    baseCredentials: opts.baseCredentials, endpoint: opts.endpoint,
  });
  const { account } = await callerAccountId({ credentials, endpoint: opts.endpoint });
  if (account !== expected) throw new Error(`Assumed identity is in account ${account}, expected ${expected}`);

  const updated: ClientConnection = { ...conn, roleArn: opts.roleArn, accountId: expected, verifiedAt: new Date().toISOString() };
  await store.put(updated);
  return updated;
}

export interface ClientAuditOptions extends Omit<AuditOptions, "credentials"> {
  baseCredentials?: AwsCredentialIdentityProvider;
}

/** Assume a connected client's role and audit it. Uses the client's registered regions by default. */
export async function auditClient(store: ConnectionStore, name: string, opts: ClientAuditOptions = {}): Promise<AuditResult> {
  const conn = await store.get(name);
  if (!conn) throw new Error(`Unknown client '${name}'`);
  if (!conn.roleArn) throw new Error(`Client '${name}' has not been verified yet`);
  const { baseCredentials, ...rest } = opts;
  const credentials = assumeRoleCredentials({
    roleArn: conn.roleArn, externalId: conn.externalId, baseCredentials, endpoint: opts.endpoint,
    region: opts.regions?.[0] ?? conn.regions?.[0],
  });
  return runAudit({ ...rest, credentials, regions: opts.regions ?? (conn.regions?.length ? conn.regions : undefined) });
}

export interface ClientTechAuditOptions extends Omit<TechAuditOptions, "credentials"> {
  baseCredentials?: AwsCredentialIdentityProvider;
}

/** Assume a connected client's role and run the Engg Tech Audit checks. Uses the client's registered regions by default. */
export async function techAuditClient(store: ConnectionStore, name: string, opts: ClientTechAuditOptions = {}): Promise<TechAuditResult> {
  const conn = await store.get(name);
  if (!conn) throw new Error(`Unknown client '${name}'`);
  if (!conn.roleArn) throw new Error(`Client '${name}' has not been verified yet`);
  const { baseCredentials, ...rest } = opts;
  const credentials = assumeRoleCredentials({
    roleArn: conn.roleArn, externalId: conn.externalId, sessionName: "tech-audit", baseCredentials, endpoint: opts.endpoint,
    region: opts.regions?.[0] ?? conn.regions?.[0],
  });
  return runTechAudit({ ...rest, credentials, regions: opts.regions ?? (conn.regions?.length ? conn.regions : undefined) });
}
