import { mkdtemp, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInvite, FileConnectionStore, MemoryConnectionStore, quickCreateUrl, TEMPLATE_PATH,
} from "../src/onboarding.js";
import { accountIdFromRoleArn, assumeRoleCredentials } from "../src/credentials.js";

describe("createInvite", () => {
  it("issues a stable external ID until rotated", async () => {
    const store = new MemoryConnectionStore();
    const a = await createInvite(store, { name: "acme", trustedAccountId: "111111111111", regions: ["eu-west-2"] });
    expect(a.parameters.ExternalId).toMatch(/^[0-9a-f]{40}$/);
    const b = await createInvite(store, { name: "acme", trustedAccountId: "111111111111" });
    expect(b.parameters.ExternalId).toBe(a.parameters.ExternalId);
    expect(b.connection.regions).toEqual(["eu-west-2"]);

    await store.put({ ...b.connection, roleArn: "arn:aws:iam::222222222222:role/eol-audit-readonly" });
    await expect(createInvite(store, { name: "acme", trustedAccountId: "111111111111" })).rejects.toThrow(/already connected/);

    const c = await createInvite(store, { name: "acme", trustedAccountId: "111111111111", rotate: true });
    expect(c.parameters.ExternalId).not.toBe(a.parameters.ExternalId);
    expect(c.connection.roleArn).toBeUndefined();
  });

  it("validates input", async () => {
    const store = new MemoryConnectionStore();
    await expect(createInvite(store, { name: "Bad Name", trustedAccountId: "111111111111" })).rejects.toThrow();
    await expect(createInvite(store, { name: "acme", trustedAccountId: "123" })).rejects.toThrow();
  });
});

describe("FileConnectionStore", () => {
  it("persists with 0600 permissions", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "eol-")), "nested", "clients.json");
    const store = new FileConnectionStore(path);
    expect(await store.list()).toEqual([]);
    await createInvite(store, { name: "acme", trustedAccountId: "111111111111" });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await readFile(path, "utf8")).clients.acme.trustedAccountId).toBe("111111111111");
    expect(await store.delete("acme")).toBe(true);
    expect(await store.delete("acme")).toBe(false);
  });
});

describe("quickCreateUrl", () => {
  it("builds an encoded console link and rejects non-S3 templates", () => {
    const url = quickCreateUrl({
      templateUrl: "https://bucket.s3.eu-west-2.amazonaws.com/t.yaml", region: "eu-west-2",
      parameters: { TrustedAccountId: "111111111111", ExternalId: "abc123abc123abc123" },
    });
    expect(url).toContain("#/stacks/create/review?");
    expect(url).toContain("param_ExternalId=abc123abc123abc123");
    expect(url).not.toContain("TrustedPrincipalArn");
    expect(() => quickCreateUrl({ templateUrl: "http://evil.test/t.yaml", region: "eu-west-2",
      parameters: { TrustedAccountId: "1", ExternalId: "x" } })).toThrow();
  });
});

describe("credentials", () => {
  it("validates role ARNs and external IDs", () => {
    expect(accountIdFromRoleArn("arn:aws:iam::222222222222:role/eol-audit-readonly")).toBe("222222222222");
    expect(() => accountIdFromRoleArn("arn:aws:iam::22:role/x")).toThrow();
    expect(() => assumeRoleCredentials({ roleArn: "arn:aws:iam::222222222222:role/x", externalId: "bad id!" })).toThrow();
    expect(typeof assumeRoleCredentials({ roleArn: "arn:aws:iam::222222222222:role/x", externalId: "ok-id-123" })).toBe("function");
  });
  it("ships the CloudFormation template", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });
});
