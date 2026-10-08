import { test, expect } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const OUT = process.env.OUT!;
const MODE = process.env.MODE ?? "production";
const ROUTES = (process.env.ROUTES ?? "skeleton").split(",");
const DELAYS = (process.env.DELAYS ?? "0").split(",").map(Number);
const RS = (process.env.RS ?? "0").split(",").map(Number);
const N = Number(process.env.N ?? 5);
// Candidate switch for the #1078 experiments (src/vt-experiment.ts).
const EXP = process.env.EXP ?? "";
const load = () => execSync("uptime").toString().trim();

const IDS = [
  "bc-fb",
  "bc-fb-outer",
  "bc-fb-inner",
  "bc-fb-in",
  "bc-value",
  "bc-value-b",
];

function install(ids: string[]) {
  const now = () => performance.now();
  const rec: any = { t0: null, ev: [], vt: [], fetches: [] };
  (window as any).__rec = rec;
  document.addEventListener(
    "click",
    () => {
      if (rec.t0 === null) rec.t0 = now();
    },
    true,
  );
  const wrapCb = (r: any, f: any) =>
    typeof f === "function"
      ? function (this: any, ...a: any[]) {
          r.cbAt = now();
          return f.apply(this, a);
        }
      : f;
  const orig = (document as any).startViewTransition?.bind(document);
  if (orig) {
    (document as any).startViewTransition = function (arg: any) {
      const r: any = { start: now() };
      rec.vt.push(r);
      let a = arg;
      if (typeof arg === "function") a = wrapCb(r, arg);
      else if (arg && typeof arg === "object")
        a = { ...arg, update: wrapCb(r, arg.update) };
      const vt = orig(a);
      vt.ready.then(
        () => (r.ready = now()),
        () => (r.readyErr = now()),
      );
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
    if (!url.includes("/base-cost/")) return of(input, init);
    const f: any = { url, start: now() };
    rec.fetches.push(f);
    return of(input, init).then((res) => {
      f.headersAt = now();
      try {
        const rd = res.clone().body!.getReader();
        const pump = (): any =>
          rd.read().then((c) => {
            if (c.done) {
              f.end = now();
              return;
            }
            if (f.firstByte === undefined) f.firstByte = now();
            return pump();
          });
        pump().catch(() => {});
      } catch {}
      return res;
    });
  } as any;
  const state: Record<string, boolean> = {};
  const scan = () => {
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const present =
        !!el &&
        !el.closest('[style*="display: none"]') &&
        !el.closest("[hidden]");
      if ((state[id] ?? false) !== present) {
        state[id] = present;
        rec.ev.push({ id, present, t: now() });
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

test("base cost", async ({ browser }) => {
  appendFileSync(OUT + ".meta", `${MODE} start ${load()}\n`);
  const ctx = await browser.newContext();
  await ctx.addInitScript(install, IDS);
  if (EXP) {
    await ctx.addInitScript((exp) => {
      (window as any).__RANGO_VT_EXP = exp;
    }, EXP);
  }
  for (const route of ROUTES) {
    for (const r of RS) {
      for (const delay of DELAYS) {
        for (let i = 0; i < N; i++) {
          const page = await ctx.newPage();
          if (r > 0) {
            await page.route(/\/base-cost\/[^/?]+/, async (route2) => {
              await new Promise((x) => setTimeout(x, r));
              await route2.continue();
            });
          }
          await page.goto("/base-cost/");
          const link = page.getByTestId(`bc-link-${route}-${delay}`);
          await link.waitFor();
          await page.waitForTimeout(500);
          const pre = await page.evaluate(
            () => (window as any).__rec.fetches.length,
          );
          expect(pre, "no RSC fetch for a target before the click").toBe(0);
          await link.click();
          const two = route.startsWith("vt-two");
          await page.waitForFunction(
            (two) => {
              const q = (id: string) =>
                !!document.querySelector(`[data-testid="${id}"]`);
              return q("bc-value") && (!two || q("bc-value-b"));
            },
            two,
            { timeout: 15000 },
          );
          await page.waitForTimeout(900);
          const rec = await page.evaluate(() => (window as any).__rec);
          const t0 = rec.t0;
          const rel = (x: any) =>
            typeof x === "number" ? +(x - t0).toFixed(1) : null;
          const row = {
            exp: EXP,
            load: load(),
            mode: MODE,
            route,
            r,
            delay,
            i,
            ev: rec.ev.map((e: any) => ({
              id: e.id,
              p: e.present,
              t: rel(e.t),
            })),
            vt: rec.vt.map((v: any) => ({
              start: rel(v.start),
              cb: rel(v.cbAt),
              ready: rel(v.ready),
              finished: rel(v.finished),
            })),
            fetches: rec.fetches.map((f: any) => ({
              url: f.url.replace(/^https?:\/\/[^/]+/, ""),
              start: rel(f.start),
              headers: rel(f.headersAt),
              firstByte: rel(f.firstByte),
              end: rel(f.end),
            })),
          };
          appendFileSync(OUT, JSON.stringify(row) + "\n");
          await page.close();
        }
      }
    }
  }
  appendFileSync(OUT + ".meta", `${MODE} end ${load()}\n`);
});
