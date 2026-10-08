// Measurement fixture, not for merge. Records one timeline for a plain click:
// every document.startViewTransition call (with stack), the DOM events the
// base-cost recorder tracks, and window.__rlog when react-dom is instrumented
// (scratchpad patch-react-dev.py, never committed).
import { test } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const OUT = process.env.OUT!;
const MODE = process.env.MODE ?? "dev";
const ROUTE = process.env.ROUTE ?? "vt";
const DELAY = Number(process.env.DELAY ?? 400);
const N = Number(process.env.N ?? 1);
const PREVISIT = process.env.PREVISIT ?? "";
const EXP = process.env.EXP ?? "";
const load = () => execSync("uptime").toString().trim();

function install() {
  const now = () => performance.now();
  const rec: any = { t0: null, ev: [], vt: [] };
  (window as any).__rec = rec;
  (window as any).__rlog = [];
  document.addEventListener(
    "click",
    () => {
      if (rec.t0 === null) {
        rec.t0 = now();
        (window as any).__rlog.push({ k: "click", t: rec.t0 });
      }
    },
    true,
  );
  const orig = (document as any).startViewTransition?.bind(document);
  if (orig) {
    (document as any).startViewTransition = function (arg: any) {
      const r: any = { start: now(), stack: new Error().stack };
      rec.vt.push(r);
      const vt = orig(arg);
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
  const ids = ["bc-fb", "bc-value", "bc-value-b", "bc-vt-page"];
  const state: Record<string, string> = {};
  const scan = () => {
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const s = !el
        ? "absent"
        : el.closest('[style*="display: none"]') || el.closest("[hidden]")
          ? "hidden"
          : "visible";
      if ((state[id] ?? "absent") !== s) {
        state[id] = s;
        rec.ev.push({ id, s, t: now() });
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

test("vt trace", async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(install);
  if (EXP) {
    await ctx.addInitScript((exp) => {
      (window as any).__RANGO_VT_EXP = exp;
    }, EXP);
  }
  for (let i = 0; i < N; i++) {
    const page = await ctx.newPage();
    await page.goto("/base-cost/");
    const link = page.getByTestId(`bc-link-${ROUTE}-${DELAY}`);
    await link.waitFor();
    await page.waitForTimeout(700);
    if (PREVISIT) {
      // Load the route's client component module first: visit a route that
      // renders the same client component, then come back to the hub.
      await page.getByTestId(`bc-link-${PREVISIT}`).click();
      await page.getByTestId("bc-value").waitFor();
      await page.waitForTimeout(800);
      await page.goBack();
      await page.getByTestId("bc-index").waitFor();
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const rec = (window as any).__rec;
        rec.t0 = null;
        rec.ev.length = 0;
        rec.vt.length = 0;
      });
    }
    await page.evaluate(() => ((window as any).__rlog.length = 0));
    await link.click();
    const two = ROUTE.startsWith("vt-two");
    await page.waitForFunction(
      (two) => {
        const q = (id: string) =>
          !!document.querySelector(`[data-testid="${id}"]`);
        return q("bc-value") && (!two || q("bc-value-b"));
      },
      two,
      { timeout: 15000 },
    );
    await page.waitForTimeout(1200);
    const { rec, rlog } = await page.evaluate(() => ({
      rec: (window as any).__rec,
      rlog: (window as any).__rlog,
    }));
    appendFileSync(
      OUT,
      JSON.stringify({
        mode: MODE,
        route: ROUTE,
        delay: DELAY,
        i,
        load: load(),
        t0: rec.t0,
        ev: rec.ev,
        vt: rec.vt,
        rlog,
      }) + "\n",
    );
    await page.close();
  }
});
