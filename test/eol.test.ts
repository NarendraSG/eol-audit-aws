import { describe, expect, it } from "vitest";
import { classify, compareVersions, EolClient, matchCycle, type EolCycle } from "../src/eol.js";
import type { Component } from "../src/types.js";

// Synthetic fixtures shaped like endoflife.date responses.
const POSTGRES: EolCycle[] = [
  { cycle: "16", eol: "2029-02-28", latest: "16.15", extendedSupport: "2032-02-29" },
  { cycle: "13", eol: "2026-02-28", latest: "13.22", extendedSupport: "2029-02-28" },
  { cycle: "11", eol: "2023-02-29", latest: "11.22", extendedSupport: "2024-02-29" },
];
const MYSQL: EolCycle[] = [
  { cycle: "8.4.9", eol: "2029-07-31", latest: "8.4.9" },
  { cycle: "8.0.46", eol: "2026-07-31", latest: "8.0.46", extendedSupport: "2029-07-31" },
  { cycle: "8.0.42", eol: "2026-07-31", latest: "8.0.42", extendedSupport: "2029-07-31" },
];
const LAMBDA: EolCycle[] = [
  { cycle: "nodejs22.x", support: "2027-04-30", eol: "2027-08-31" },
  { cycle: "nodejs16.x", support: "2024-06-12", eol: "2027-08-31" },
];
const DOCDB: EolCycle[] = [{ cycle: "5.0", eol: false }];
const TODAY = "2026-11-19";

const c = (version: string, product: string | null): Component =>
  ({ service: "x", region: "eu-west-2", resource: "r", component: "c", version, product, note: "" });

describe("compareVersions", () => {
  it("orders numerically", () => {
    expect(compareVersions("16.3", "16.15")).toBeLessThan(0);
    expect(compareVersions("3.14", "3.5")).toBeGreaterThan(0);
    expect(compareVersions("1.29", "1.29")).toBe(0);
  });
});

describe("matchCycle", () => {
  it("matches exact, prefix and patch family", () => {
    expect(matchCycle(LAMBDA, "nodejs16.x").cycle?.cycle).toBe("nodejs16.x");
    expect(matchCycle(POSTGRES, "13.11").cycle?.cycle).toBe("13");
    const fam = matchCycle(MYSQL, "8.0.35");
    expect(fam.cycle?.cycle).toBe("8.0.46");
    expect(fam.note).toMatch(/8\.0\.x family/);
    expect(matchCycle(POSTGRES, "9.6").cycle).toBeNull();
  });
});

describe("classify", () => {
  const opts = { today: TODAY, warnDays: 180 };
  it.each([
    [c("16.3", "amazon-rds-postgresql"), POSTGRES, "OK"],
    [c("13.11", "amazon-rds-postgresql"), POSTGRES, "EOL_EXTENDED_SUPPORT"],
    [c("11.4", "amazon-rds-postgresql"), POSTGRES, "EOL"],
    [c("nodejs16.x", "aws-lambda"), LAMBDA, "DEPRECATED"],
    [c("nodejs22.x", "aws-lambda"), LAMBDA, "OK"],
    [c("5.0.0", "amazon-documentdb"), DOCDB, "OK"],
    [c("9.6", "amazon-rds-postgresql"), POSTGRES, "UNKNOWN"],
    [c("x", null), null, "UNKNOWN"],
  ] as const)("%o -> %s", (comp, cycles, status) => {
    expect(classify(comp, cycles as EolCycle[] | null, opts).status).toBe(status);
  });

  it("flags EOL within the warning window", () => {
    const soon: EolCycle[] = [{ cycle: "6", eol: "2027-01-31" }];
    expect(classify(c("6.2", "p"), soon, opts).status).toBe("EOL_SOON");
    expect(classify(c("6.2", "p"), soon, { ...opts, warnDays: 30 }).status).toBe("OK");
  });

  it("notes when a patch is behind", () => {
    expect(classify(c("16.3", "amazon-rds-postgresql"), POSTGRES, opts).note).toBe("patch behind (latest 16.15)");
  });

  it("reports a product that failed to load", () => {
    const r = classify(c("1", "nope"), null, opts);
    expect(r.status).toBe("UNKNOWN");
    expect(r.note).toMatch(/could not load/);
  });
});

describe("EolClient", () => {
  it("caches per product and records failures", async () => {
    let calls = 0;
    const fetch = (async (url: string) => {
      calls++;
      if (url.endsWith("/missing.json")) return new Response("", { status: 404 });
      return Response.json(POSTGRES);
    }) as typeof globalThis.fetch;
    const client = new EolClient({ fetch, baseUrl: "https://example.test/api" });
    expect(await client.cycles("amazon-rds-postgresql")).toHaveLength(3);
    await client.cycles("amazon-rds-postgresql");
    expect(calls).toBe(1);
    expect(await client.cycles("missing")).toBeNull();
    expect(client.failures).toEqual([{ product: "missing", reason: "HTTP 404" }]);
    expect(await client.cycles("../etc/passwd")).toBeNull(); // rejected without a request
    expect(calls).toBe(2);
  });
});
