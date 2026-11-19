/** Pure helpers that turn AWS-reported strings into (product, version) pairs. */

/** Docker Hub image name -> endoflife.date product, for ECS image tag inference. */
export const IMAGE_PRODUCTS: Readonly<Record<string, string>> = {
  node: "nodejs",
  python: "python",
  postgres: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  redis: "redis",
  valkey: "valkey",
  mongo: "mongodb",
  ruby: "ruby",
  golang: "go",
  amazoncorretto: "amazon-corretto",
  nginx: "nginx",
  ubuntu: "ubuntu",
  amazonlinux: "amazon-linux",
  php: "php",
  elasticsearch: "elasticsearch",
  opensearch: "opensearch",
  memcached: "memcached",
};

export const RDS_ENGINE_PRODUCTS: Readonly<Record<string, string>> = {
  postgres: "amazon-rds-postgresql",
  mysql: "amazon-rds-mysql",
  mariadb: "amazon-rds-mariadb",
  "aurora-postgresql": "amazon-aurora-postgresql",
  "aurora-mysql": "amazon-aurora-mysql",
  docdb: "amazon-documentdb",
  neptune: "amazon-neptune",
};

export const CACHE_PRODUCTS: Readonly<Record<string, string>> = {
  redis: "amazon-elasticache-redis",
  valkey: "valkey",
  memcached: "memcached",
};

export const MQ_PRODUCTS: Readonly<Record<string, string>> = {
  rabbitmq: "amazon-mq-rabbitmq",
  activemq: "amazon-mq-activemq",
};

/** Aurora MySQL reports "8.0.mysql_aurora.3.05.2"; endoflife.date tracks the "3" line. */
export function rdsVersion(engine: string, version: string): string {
  if (engine === "aurora-mysql" && version.includes("mysql_aurora.")) {
    return version.split("mysql_aurora.")[1] ?? version;
  }
  return version;
}

/** "public.ecr.aws/docker/library/node:18-alpine" -> { base: "node", product: "nodejs", version: "18" } */
export function parseImage(image: string): { base: string; product: string | null; version: string | null } {
  const ref = image.split("@")[0] ?? image;
  const last = ref.split("/").pop() ?? ref;
  let repo = ref;
  let tag = "latest";
  if (last.includes(":")) {
    const idx = ref.lastIndexOf(":");
    repo = ref.slice(0, idx);
    tag = ref.slice(idx + 1);
  }
  const base = repo.split("/").pop() ?? repo;
  const m = /^v?(\d+(?:\.\d+){0,2})/.exec(tag);
  return { base, product: IMAGE_PRODUCTS[base] ?? null, version: m?.[1] ?? null };
}

const AMI_PATTERNS: [RegExp, string][] = [
  [/al2023-ami/, "2023"],
  [/amzn2-ami/, "2"],
  [/amzn-ami/, "2018.03"],
];
const UBUNTU_RE = /ubuntu[-/].*?(\d{2}\.\d{2})/;

/** Best-effort OS detection from an AMI's name. */
export function amiOs(name: string | undefined, platformDetails?: string): {
  component: string; product: string | null; version: string;
} {
  const n = (name ?? "").toLowerCase();
  for (const [re, version] of AMI_PATTERNS) {
    if (re.test(n)) return { component: "amazon-linux", product: "amazon-linux", version };
  }
  const m = UBUNTU_RE.exec(n);
  if (m?.[1]) return { component: "ubuntu", product: "ubuntu", version: m[1] };
  return { component: platformDetails ?? "unknown", product: null, version: n || "unknown" };
}

/** "OpenSearch_2.11" -> { kind: "OpenSearch", version: "2.11", product: "amazon-opensearch" } */
export function openSearchVersion(raw: string): { kind: string; version: string; product: string } {
  const idx = raw.indexOf("_");
  const kind = idx >= 0 ? raw.slice(0, idx) : raw;
  const version = idx >= 0 ? raw.slice(idx + 1) : "";
  return { kind, version, product: kind === "OpenSearch" ? "amazon-opensearch" : "amazon-elasticsearch" };
}
