import type { AwsCredentialIdentityProvider } from "@smithy/types";

export type ServiceName =
  | "lambda" | "rds" | "elasticache" | "opensearch" | "eks" | "msk" | "mq" | "ec2" | "ecs" | "ssm";

/** Services audited when none are specified. `ssm` is opt-in (needs SSM Inventory set up). */
export const DEFAULT_SERVICES: readonly ServiceName[] = [
  "lambda", "rds", "elasticache", "opensearch", "eks", "msk", "mq", "ec2", "ecs",
];
export const ALL_SERVICES: readonly ServiceName[] = [...DEFAULT_SERVICES, "ssm"];

/** Worst first. */
export const STATUS_ORDER = [
  "EOL", "EOL_EXTENDED_SUPPORT", "DEPRECATED", "EOL_SOON", "SECURITY_ONLY", "UNKNOWN", "OK",
] as const;
export type Status = (typeof STATUS_ORDER)[number];

/** A versioned thing found in AWS, before the EOL check. */
export interface Component {
  service: string;
  region: string;
  resource: string;
  component: string;
  version: string;
  /** endoflife.date product slug, or null when the version cannot be mapped. */
  product: string | null;
  note: string;
}

export interface AssessedComponent extends Component {
  status: Status;
  cycle: string;
  latest: string;
  supportUntil: string;
  eol: string;
  extendedSupport: string;
}

export interface CollectorError {
  service: ServiceName;
  region: string;
  code: string;
  message: string;
}

export interface AuditResult {
  accountId: string;
  regions: string[];
  startedAt: string;
  finishedAt: string;
  components: AssessedComponent[];
  /** Collectors that failed (e.g. AccessDenied). The rest of the audit still completes. */
  errors: CollectorError[];
  summary: Record<Status, number>;
}

/** Options shared by every AWS client the module creates. */
export interface AwsClientOptions {
  credentials?: AwsCredentialIdentityProvider;
  /** Override endpoint, e.g. LocalStack/moto in tests. */
  endpoint?: string;
  maxAttempts?: number;
}

export interface CollectorContext extends AwsClientOptions {
  region: string;
}

export type Collector = (ctx: CollectorContext) => Promise<Component[]>;
