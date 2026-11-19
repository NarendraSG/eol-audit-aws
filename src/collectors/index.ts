import { DescribeImagesCommand, EC2Client, paginateDescribeInstances, type Image, type Instance } from "@aws-sdk/client-ec2";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, paginateListClusters, paginateListServices } from "@aws-sdk/client-ecs";
import { DescribeClusterCommand, EKSClient, paginateListClusters as paginateEksClusters } from "@aws-sdk/client-eks";
import { DescribeServerlessCachesCommand, ElastiCacheClient, paginateDescribeCacheClusters } from "@aws-sdk/client-elasticache";
import { KafkaClient, paginateListClustersV2 } from "@aws-sdk/client-kafka";
import { LambdaClient, paginateListFunctions } from "@aws-sdk/client-lambda";
import { DescribeBrokerCommand, MqClient, paginateListBrokers } from "@aws-sdk/client-mq";
import { DescribeDomainsCommand, ListDomainNamesCommand, OpenSearchClient } from "@aws-sdk/client-opensearch";
import { paginateDescribeDBClusters, paginateDescribeDBInstances, RDSClient } from "@aws-sdk/client-rds";
import { ListInventoryEntriesCommand, paginateDescribeInstanceInformation, SSMClient } from "@aws-sdk/client-ssm";
import type { Collector, CollectorContext, Component, ServiceName } from "../types.js";
import { amiOs, CACHE_PRODUCTS, MQ_PRODUCTS, openSearchVersion, parseImage, RDS_ENGINE_PRODUCTS, rdsVersion } from "./parse.js";

/** Config passed to every SDK client. */
export function clientConfig(ctx: CollectorContext) {
  return {
    region: ctx.region,
    credentials: ctx.credentials,
    endpoint: ctx.endpoint,
    maxAttempts: ctx.maxAttempts ?? 10,
    retryMode: "adaptive" as const,
  };
}

function comp(c: Omit<Component, "note"> & { note?: string }): Component {
  return { note: "", ...c };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const collectLambda: Collector = async (ctx) => {
  const client = new LambdaClient(clientConfig(ctx));
  const out: Component[] = [];
  for await (const page of paginateListFunctions({ client }, {})) {
    for (const fn of page.Functions ?? []) {
      const name = fn.FunctionName ?? "unknown";
      if (!fn.Runtime) {
        // Container-image functions have no managed runtime.
        out.push(comp({ service: "lambda", region: ctx.region, resource: name, component: "runtime",
          version: "container-image", product: null, note: "image-based: scan the ECR image instead" }));
        continue;
      }
      out.push(comp({ service: "lambda", region: ctx.region, resource: name, component: "runtime",
        version: fn.Runtime, product: "aws-lambda" }));
    }
  }
  return out;
};

export const collectRds: Collector = async (ctx) => {
  const client = new RDSClient(clientConfig(ctx));
  const out: Component[] = [];
  const clusters = new Set<string>();
  for await (const page of paginateDescribeDBClusters({ client }, {})) {
    for (const cl of page.DBClusters ?? []) {
      const id = cl.DBClusterIdentifier ?? "unknown";
      const engine = cl.Engine ?? "unknown";
      clusters.add(id);
      out.push(comp({ service: "rds-cluster", region: ctx.region, resource: id, component: engine,
        version: rdsVersion(engine, cl.EngineVersion ?? ""), product: RDS_ENGINE_PRODUCTS[engine] ?? null }));
    }
  }
  for await (const page of paginateDescribeDBInstances({ client }, {})) {
    for (const db of page.DBInstances ?? []) {
      if (db.DBClusterIdentifier && clusters.has(db.DBClusterIdentifier)) continue; // reported per cluster
      const engine = db.Engine ?? "unknown";
      out.push(comp({ service: "rds", region: ctx.region, resource: db.DBInstanceIdentifier ?? "unknown",
        component: engine, version: rdsVersion(engine, db.EngineVersion ?? ""),
        product: RDS_ENGINE_PRODUCTS[engine] ?? null }));
    }
  }
  return out;
};

export const collectElastiCache: Collector = async (ctx) => {
  const client = new ElastiCacheClient(clientConfig(ctx));
  const out: Component[] = [];
  const groups = new Set<string>();
  for await (const page of paginateDescribeCacheClusters({ client }, {})) {
    for (const c of page.CacheClusters ?? []) {
      const group = c.ReplicationGroupId;
      if (group) {
        if (groups.has(group)) continue;
        groups.add(group);
      }
      const engine = c.Engine ?? "unknown";
      out.push(comp({ service: "elasticache", region: ctx.region, resource: group ?? c.CacheClusterId ?? "unknown",
        component: engine, version: c.EngineVersion ?? "", product: CACHE_PRODUCTS[engine] ?? null }));
    }
  }
  // Serverless caches are newer and not in every region/partition; treat failure as "none".
  try {
    let token: string | undefined;
    do {
      const res = await client.send(new DescribeServerlessCachesCommand({ NextToken: token }));
      for (const s of res.ServerlessCaches ?? []) {
        const engine = s.Engine ?? "unknown";
        out.push(comp({ service: "elasticache-serverless", region: ctx.region,
          resource: s.ServerlessCacheName ?? "unknown", component: engine,
          version: s.FullEngineVersion ?? s.MajorEngineVersion ?? "", product: CACHE_PRODUCTS[engine] ?? null }));
      }
      token = res.NextToken;
    } while (token);
  } catch {
    /* not available here */
  }
  return out;
};

export const collectOpenSearch: Collector = async (ctx) => {
  const client = new OpenSearchClient(clientConfig(ctx));
  const names = ((await client.send(new ListDomainNamesCommand({}))).DomainNames ?? [])
    .map((d) => d.DomainName)
    .filter((n): n is string => !!n);
  const out: Component[] = [];
  for (const batch of chunks(names, 5)) { // DescribeDomains takes at most 5 names
    const res = await client.send(new DescribeDomainsCommand({ DomainNames: batch }));
    for (const d of res.DomainStatusList ?? []) {
      const v = openSearchVersion(d.EngineVersion ?? "");
      out.push(comp({ service: "opensearch", region: ctx.region, resource: d.DomainName ?? "unknown",
        component: v.kind, version: v.version, product: v.product }));
    }
  }
  return out;
};

export const collectEks: Collector = async (ctx) => {
  const client = new EKSClient(clientConfig(ctx));
  const out: Component[] = [];
  for await (const page of paginateEksClusters({ client }, {})) {
    for (const name of page.clusters ?? []) {
      const c = (await client.send(new DescribeClusterCommand({ name }))).cluster;
      out.push(comp({ service: "eks", region: ctx.region, resource: name, component: "kubernetes",
        version: c?.version ?? "", product: "amazon-eks" }));
    }
  }
  return out;
};

export const collectMsk: Collector = async (ctx) => {
  const client = new KafkaClient(clientConfig(ctx));
  const out: Component[] = [];
  for await (const page of paginateListClustersV2({ client }, {})) {
    for (const c of page.ClusterInfoList ?? []) {
      const ver = c.Provisioned?.CurrentBrokerSoftwareInfo?.KafkaVersion;
      if (!ver) continue; // serverless MSK has no broker version
      out.push(comp({ service: "msk", region: ctx.region, resource: c.ClusterName ?? "unknown",
        component: "kafka", version: ver.split(".tiered")[0] ?? ver, product: "amazon-msk" }));
    }
  }
  return out;
};

export const collectMq: Collector = async (ctx) => {
  const client = new MqClient(clientConfig(ctx));
  const out: Component[] = [];
  for await (const page of paginateListBrokers({ client }, {})) {
    for (const b of page.BrokerSummaries ?? []) {
      if (!b.BrokerId) continue;
      const d = await client.send(new DescribeBrokerCommand({ BrokerId: b.BrokerId }));
      const engine = (d.EngineType ?? "unknown").toLowerCase();
      out.push(comp({ service: "mq", region: ctx.region, resource: d.BrokerName ?? b.BrokerId,
        component: engine, version: d.EngineVersion ?? "", product: MQ_PRODUCTS[engine] ?? null }));
    }
  }
  return out;
};

export const collectEc2: Collector = async (ctx) => {
  const client = new EC2Client(clientConfig(ctx));
  const instances: Instance[] = [];
  const filters = [{ Name: "instance-state-name", Values: ["running", "stopped"] }];
  for await (const page of paginateDescribeInstances({ client }, { Filters: filters })) {
    for (const r of page.Reservations ?? []) instances.push(...(r.Instances ?? []));
  }
  const amiIds = [...new Set(instances.map((i) => i.ImageId).filter((id): id is string => !!id))].sort();
  const images = new Map<string, Image>();
  for (const batch of chunks(amiIds, 100)) {
    const res = await client.send(new DescribeImagesCommand({ ImageIds: batch, IncludeDeprecated: true }));
    for (const img of res.Images ?? []) if (img.ImageId) images.set(img.ImageId, img);
  }
  return instances.map((inst) => {
    const name = inst.Tags?.find((t) => t.Key === "Name")?.Value ?? inst.InstanceId ?? "unknown";
    const img = inst.ImageId ? images.get(inst.ImageId) : undefined;
    if (!img) {
      return comp({ service: "ec2", region: ctx.region, resource: name, component: "os",
        version: inst.ImageId ?? "unknown", product: null,
        note: "AMI deregistered or not shared; check OS on the host" });
    }
    const os = amiOs(img.Name, img.PlatformDetails);
    return comp({ service: "ec2", region: ctx.region, resource: name, component: os.component,
      version: os.version, product: os.product,
      note: os.product ? "" : `unrecognised AMI name '${img.Name ?? ""}'` });
  });
};

export const collectEcs: Collector = async (ctx) => {
  const client = new ECSClient(clientConfig(ctx));
  const taskDefs = new Map<string, string>(); // task definition ARN -> "cluster/service"
  for await (const page of paginateListClusters({ client }, {})) {
    for (const cluster of page.clusterArns ?? []) {
      const cname = cluster.split("/").pop() ?? cluster;
      const svcArns: string[] = [];
      for await (const sp of paginateListServices({ client }, { cluster })) svcArns.push(...(sp.serviceArns ?? []));
      for (const batch of chunks(svcArns, 10)) {
        const res = await client.send(new DescribeServicesCommand({ cluster, services: batch }));
        for (const svc of res.services ?? []) {
          if (svc.taskDefinition && !taskDefs.has(svc.taskDefinition)) {
            taskDefs.set(svc.taskDefinition, `${cname}/${svc.serviceName ?? "unknown"}`);
          }
        }
      }
    }
  }
  const out: Component[] = [];
  for (const [arn, label] of taskDefs) {
    const td = (await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }))).taskDefinition;
    for (const cd of td?.containerDefinitions ?? []) {
      const image = cd.image ?? "";
      const { base, product, version } = parseImage(image);
      const resource = `${label}:${cd.name ?? "container"}`;
      if (product && version) {
        out.push(comp({ service: "ecs", region: ctx.region, resource, component: base, version, product }));
      } else {
        out.push(comp({ service: "ecs", region: ctx.region, resource, component: base, version: image, product: null,
          note: product ? "no version in tag (e.g. :latest); pin a version"
            : "custom image: use Inspector SBOM to see runtime versions" }));
      }
    }
  }
  return out;
};

/**
 * Node.js/Python found by SSM Inventory on managed EC2 instances. Needs the SSM agent and an
 * inventory association; runtimes installed via nvm/pyenv are not reported.
 */
export const collectSsm: Collector = async (ctx) => {
  const client = new SSMClient(clientConfig(ctx));
  const out: Component[] = [];
  for await (const page of paginateDescribeInstanceInformation({ client }, {})) {
    for (const inst of page.InstanceInformationList ?? []) {
      if (!inst.InstanceId) continue;
      for (const [prefix, product] of [["nodejs", "nodejs"], ["python3", "python"]] as const) {
        const res = await client.send(new ListInventoryEntriesCommand({
          InstanceId: inst.InstanceId, TypeName: "AWS:Application",
          Filters: [{ Key: "Name", Values: [prefix], Type: "BeginWith" }],
        }));
        for (const e of res.Entries ?? []) {
          const ver = /^\d+(?:\.\d+)*/.exec(e["Version"] ?? "")?.[0];
          if (ver) {
            out.push(comp({ service: "ec2-ssm", region: ctx.region, resource: inst.InstanceId,
              component: e["Name"] ?? prefix, version: ver, product }));
          }
        }
      }
    }
  }
  return out;
};

export const COLLECTORS: Readonly<Record<ServiceName, Collector>> = {
  lambda: collectLambda,
  rds: collectRds,
  elasticache: collectElastiCache,
  opensearch: collectOpenSearch,
  eks: collectEks,
  msk: collectMsk,
  mq: collectMq,
  ec2: collectEc2,
  ecs: collectEcs,
  ssm: collectSsm,
};
