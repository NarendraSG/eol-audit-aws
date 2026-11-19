import { describe, expect, it } from "vitest";
import { amiOs, openSearchVersion, parseImage, rdsVersion } from "../src/collectors/parse.js";

describe("parseImage", () => {
  it.each([
    ["public.ecr.aws/docker/library/node:18-alpine", { base: "node", product: "nodejs", version: "18" }],
    ["python:3.11-slim@sha256:abc", { base: "python", product: "python", version: "3.11" }],
    ["123456789012.dkr.ecr.eu-west-2.amazonaws.com/my-api:abc123", { base: "my-api", product: null, version: null }],
    ["localhost:5000/node", { base: "node", product: "nodejs", version: null }],
    ["postgres:v16.2", { base: "postgres", product: "postgresql", version: "16.2" }],
  ])("%s", (image, expected) => {
    expect(parseImage(image)).toEqual(expected);
  });
});

describe("amiOs", () => {
  it("recognises Amazon Linux and Ubuntu", () => {
    expect(amiOs("al2023-ami-2023.6.20241010.0-kernel-6.1-x86_64").version).toBe("2023");
    expect(amiOs("amzn2-ami-ecs-hvm-2.0.2024-x86_64-ebs").version).toBe("2");
    expect(amiOs("ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20240101")).toEqual(
      { component: "ubuntu", product: "ubuntu", version: "22.04" });
  });
  it("falls back to platform details", () => {
    expect(amiOs("Windows_Server-2019", "Windows")).toEqual(
      { component: "Windows", product: null, version: "windows_server-2019" });
  });
});

describe("rdsVersion / openSearchVersion", () => {
  it("extracts the Aurora MySQL line", () => {
    expect(rdsVersion("aurora-mysql", "8.0.mysql_aurora.3.05.2")).toBe("3.05.2");
    expect(rdsVersion("postgres", "16.3")).toBe("16.3");
  });
  it("splits OpenSearch engine strings", () => {
    expect(openSearchVersion("OpenSearch_2.11")).toEqual({ kind: "OpenSearch", version: "2.11", product: "amazon-opensearch" });
    expect(openSearchVersion("Elasticsearch_7.10").product).toBe("amazon-elasticsearch");
  });
});
