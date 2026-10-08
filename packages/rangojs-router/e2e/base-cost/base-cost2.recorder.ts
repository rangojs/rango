import { test } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const OUT = process.env.OUT!;
const MODE = process.env.MODE ?? "production";
const N = Number(process.env.N ?? 5);
const PREFETCH = process.env.PREFETCH === "1";
const PREFIX =
  process.env.PREFIX ?? (PREFETCH ? "/base-cost-p" : "/base-cost-a");
const START = process.env.START ?? "/";
const load = () => execSync("uptime").toString().trim();

const IDS = [
  "bc-fb",
  "bc-fb-outer",
  "bc-value",
  "bc-nl-done",
  "bc-nl-a",
  "bc-nl-b",
  "bc-sib",
  "bc3-fb-outer",
  "bc3-fb-slot",
  "bc3-fb-rs-a",
  "bc3-fb-rs-b",
  "bc3-wl-value",
  "bc3-slot-value",
  "bc3-rs-layout",
  "bc3-wl-layout",
  "bc3-slot-layout",
  "bc3-wl-a",
  "bc3-wl-b",
  "bc3-slot-a",
  "bc3-slot-b",
  "bc3-rs-a-value",
  "bc3-rs-b-value",
];
const FBS = ["bc-fb", "bc-fb-outer"];

function install(ids: string[]) {
  const now = () => performance.now();
  const rec: any = { clicks: [], ev: [], vt: [], fetches: [] };
  (window as any).__rec = rec;
  const state: Record<string, boolean> = {};
  document.addEventListener(
    "click",
    () => rec.clicks.push({ t: now(), snap: ids.filter((i) => state[i]) }),
    true,
  );
  const orig = (document as any).startViewTransition?.bind(document);
  if (orig) {
    (document as any).startViewTransition = function (arg: any) {
      const r: any = { start: now() };
      rec.vt.push(r);
      const vt = orig(arg);
      vt.finished.then(
        () => (r.finished = now()),
        () => (r.finished = now()),
      );
      return vt;
    };
  }
  const of = window.fetch.bind(window);
  window.fetch = function (input: any, init?: any) {
    const url =
      typeof input === "string" ? input : (input.url ?? String(input));
    if (!url.includes("/base-cost-") && !url.includes("/bc3-"))
      return of(input, init);
    const f: any = { url, start: now() };
    rec.fetches.push(f);
    return of(input, init).then((res) => {
      try {
        const rd = res.clone().body!.getReader();
        const pump = (): any =>
          rd.read().then((c) => {
            if (c.done) {
              f.end = now();
              return;
            }
            return pump();
          });
        pump().catch(() => {});
      } catch {}
      return res;
    });
  } as any;
  const scan = () => {
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const present =
        !!el &&
        !el.closest('[style*="display: none"]') &&
        !el.closest("[hidden]");
      if ((state[id] ?? false) !== present) {
        state[id] = present;
        rec.ev.push({ id, p: present, t: now() });
      }
    }
  };
  new MutationObserver(scan).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style", "hidden"],
  });
}

// scenario: list of [linkTestId, completeMarker, measured]
const SCEN: Record<string, [string, string][]> = {
  wl: [
    ["bc3-link-wl-a", "bc3-wl-a"],
    ["bc3-link-wl-b", "bc3-wl-b"],
  ],
  slot: [
    ["bc3-link-slot-a", "bc3-slot-a"],
    ["bc3-link-slot-b", "bc3-slot-b"],
  ],
  rs: [
    ["bc3-link-rs-a", "bc3-rs-a-value"],
    ["bc3-link-rs-b", "bc3-rs-b-value"],
  ],
  "wl-b": [["bc3-link-wl-b", "bc3-wl-b"]],
  "slot-b": [["bc3-link-slot-b", "bc3-slot-b"]],
  "rs-b": [["bc3-link-rs-b", "bc3-rs-b-value"]],
  "b-only": [["bc-link-nl-b", "bc-nl-b"]],
  "noloader-cold": [["bc-link-noloader", "bc-nl-done"]],
  "layout-a-cold": [["bc-link-nl-a", "bc-nl-a"]],
  "layout-a-then-b": [
    ["bc-link-nl-a", "bc-nl-a"],
    ["bc-link-nl-b", "bc-nl-b"],
  ],
  "noloader-after-layout-a": [
    ["bc-link-nl-a", "bc-nl-a"],
    ["bc-link-noloader", "bc-nl-done"],
  ],
  "layout-a-after-noloader": [
    ["bc-link-noloader", "bc-nl-done"],
    ["bc-link-nl-a", "bc-nl-a"],
  ],
};
for (const d of [100, 300, 500]) {
  SCEN[`own-vt-${d}`] = [[`bc-link-own-vt-${d}`, "bc-value"]];
  SCEN[`own-vt-layout-${d}`] = [[`bc-link-own-vt-layout-${d}`, "bc-value"]];
  SCEN[`own-vt-layout-held-${d}`] = [
    ["bc-link-own-vt-sib", "bc-sib"],
    [`bc-link-own-vt-layout-${d}`, "bc-value"],
  ];
}
const WANT = (process.env.SCEN ?? Object.keys(SCEN).join(",")).split(",");

test("base cost 2", async ({ browser }) => {
  appendFileSync(OUT + ".meta", `${MODE} pf=${PREFETCH} start ${load()}\n`);
  const ctx = await browser.newContext();
  await ctx.addInitScript(install, IDS);
  for (const name of WANT) {
    for (let i = 0; i < N; i++) {
      const page = await ctx.newPage();
      await page.goto(`${PREFIX}${START}`);
      await page.getByTestId("bc-hub").waitFor();
      await page.waitForTimeout(600);
      if (PREFETCH) {
        await page.waitForFunction(() => {
          const f = (window as any).__rec.fetches;
          return f.length > 0 && f.every((x: any) => x.end !== undefined);
        });
        await page.waitForTimeout(500);
      } else {
        const n = await page.evaluate(
          () => (window as any).__rec.fetches.length,
        );
        if (n !== 0) throw new Error("fetch before click");
      }
      const bf = await page.evaluate(
        () =>
          (window as any).__rec.fetches.filter((f: any) =>
            /\/(b|wl\/b|slot\/b|rs\/b)(\?|$)/.test(
              f.url.split("?")[0].replace(/^https?:\/\/[^/]+/, ""),
            ),
          ).length,
      );
      if (bf !== 0) throw new Error("fetch for b before click");
      const steps = SCEN[name];
      for (const [link, marker] of steps) {
        await page.getByTestId(link).click();
        await page.waitForFunction(
          (m) => !!document.querySelector(`[data-testid="${m}"]`),
          marker,
          { timeout: 15000 },
        );
        await page.waitForTimeout(900);
      }
      const rec = await page.evaluate(() => (window as any).__rec);
      const ci = rec.clicks.length - 1; // measured = last click
      const c = rec.clicks[ci];
      const rel = (x: any) =>
        typeof x === "number" ? +(x - c.t).toFixed(1) : null;
      const marker = steps[steps.length - 1][1];
      const row = {
        mode: MODE,
        prefetch: PREFETCH,
        scen: name + (process.env.LABEL ?? ""),
        i,
        snap: c.snap,
        ev: rec.ev
          .filter((e: any) => e.t >= c.t)
          .map((e: any) => ({ id: e.id, p: e.p, t: rel(e.t) })),
        vt: rec.vt
          .filter((v: any) => v.start >= c.t)
          .map((v: any) => ({
            start: rel(v.start),
            finished: rel(v.finished),
          })),
        fetchesAfterClick: rec.fetches
          .filter((f: any) => f.start >= c.t)
          .map((f: any) => f.url.replace(/_rsc_segments=[^&]*/, "")),
        marker,
      };
      appendFileSync(OUT, JSON.stringify(row) + "\n");
      await page.close();
    }
  }
  appendFileSync(OUT + ".meta", `${MODE} pf=${PREFETCH} end ${load()}\n`);
});
