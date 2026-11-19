import type { AssessedComponent, Component, Status } from "./types.js";

/** One release cycle as returned by https://endoflife.date/api/{product}.json */
export interface EolCycle {
  cycle: string | number;
  eol?: string | boolean;
  support?: string | boolean;
  extendedSupport?: string | boolean;
  latest?: string | null;
}

export interface EolClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Fetches and caches endoflife.date product data. Failed lookups resolve to null. */
export class EolClient {
  private readonly cache = new Map<string, Promise<EolCycle[] | null>>();
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  readonly failures: { product: string; reason: string }[] = [];

  constructor(opts: EolClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://endoflife.date/api").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  cycles(product: string): Promise<EolCycle[] | null> {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(product)) {
      return Promise.resolve(null);
    }
    let pending = this.cache.get(product);
    if (!pending) {
      pending = this.load(product);
      this.cache.set(product, pending);
    }
    return pending;
  }

  private async load(product: string): Promise<EolCycle[] | null> {
    const url = `${this.baseUrl}/${product}.json`;
    try {
      const res = await this.fetchFn(url, {
        headers: { "User-Agent": "aws-eol-audit/0.1" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.failures.push({ product, reason: `HTTP ${res.status}` });
        return null;
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        this.failures.push({ product, reason: "unexpected response shape" });
        return null;
      }
      return body as EolCycle[];
    } catch (err) {
      this.failures.push({ product, reason: (err as Error).message });
      return null;
    }
  }
}

/** Compare dotted versions numerically; non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const pb = b.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return pa.length - pb.length;
}

/**
 * Find the release cycle for a version.
 * 1. exact match ("nodejs20.x")
 * 2. longest cycle that is a dotted prefix of the version ("14" for "14.7")
 * 3. products listing full patch versions as cycles (RDS MySQL "8.0.46"): newest cycle in the
 *    same major.minor family, flagged as approximate.
 */
export function matchCycle(cycles: EolCycle[], version: string): { cycle: EolCycle | null; note: string } {
  const byName = new Map(cycles.map((c) => [String(c.cycle), c]));
  const exact = byName.get(version);
  if (exact) return { cycle: exact, note: "" };

  const prefixes = [...byName.keys()].filter((n) => version.startsWith(`${n}.`) || version.startsWith(`${n}-`));
  if (prefixes.length) {
    const best = prefixes.reduce((a, b) => (b.length > a.length ? b : a));
    return { cycle: byName.get(best)!, note: "" };
  }

  const family = version.split(".").slice(0, 2).join(".");
  const siblings = [...byName.keys()].filter((n) => n.startsWith(`${family}.`));
  if (siblings.length) {
    const best = siblings.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
    return { cycle: byName.get(best)!, note: `exact version not listed, using ${family}.x family (${best})` };
  }
  return { cycle: null, note: "" };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

function fmt(v: string | boolean | undefined): string {
  return v === undefined ? "" : String(v);
}

export interface ClassifyOptions {
  /** Flag EOL within this many days as EOL_SOON. Default 180. */
  warnDays?: number;
  /** YYYY-MM-DD, defaults to today (UTC). */
  today?: string;
}

/** Pure: assess one component against the product's cycles (null when the product could not be loaded). */
export function classify(comp: Component, cycles: EolCycle[] | null, opts: ClassifyOptions = {}): AssessedComponent {
  const warnDays = opts.warnDays ?? 180;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const base: AssessedComponent = {
    ...comp, status: "UNKNOWN", cycle: "", latest: "", supportUntil: "", eol: "", extendedSupport: "",
  };

  if (!comp.product) return { ...base, note: comp.note || "no endoflife.date mapping" };
  if (!cycles) return { ...base, note: `could not load endoflife.date/${comp.product}` };

  const { cycle, note } = matchCycle(cycles, comp.version);
  if (!cycle) return { ...base, note: `version '${comp.version}' not found in ${comp.product}` };

  const passed = (v: unknown) => v === true || (typeof v === "string" && ISO_DATE.test(v) && v <= today);
  const future = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && v > today;

  let status: Status;
  if (passed(cycle.eol)) {
    // AWS "extended support" keeps some engines running past EOL, at extra cost.
    status = future(cycle.extendedSupport) ? "EOL_EXTENDED_SUPPORT" : "EOL";
  } else if (future(cycle.eol) && daysBetween(today, cycle.eol) <= warnDays) {
    status = "EOL_SOON";
  } else if (passed(cycle.support) && cycle.support !== true) {
    // For Lambda "support" is the deprecation date; elsewhere the end of active support.
    status = comp.product === "aws-lambda" ? "DEPRECATED" : "SECURITY_ONLY";
  } else {
    status = "OK";
  }

  const latest = cycle.latest ? String(cycle.latest) : "";
  let finalNote = note;
  if (status === "OK" && !note && /^[\d.]+$/.test(latest) && compareVersions(comp.version, latest) < 0) {
    finalNote = `patch behind (latest ${latest})`;
  }

  return {
    ...base,
    status,
    note: finalNote,
    cycle: String(cycle.cycle),
    latest,
    supportUntil: fmt(cycle.support),
    eol: fmt(cycle.eol),
    extendedSupport: fmt(cycle.extendedSupport),
  };
}

export async function assessAll(
  components: Component[], client: EolClient, opts: ClassifyOptions = {},
): Promise<AssessedComponent[]> {
  return Promise.all(
    components.map(async (c) => classify(c, c.product ? await client.cycles(c.product) : null, opts)),
  );
}
