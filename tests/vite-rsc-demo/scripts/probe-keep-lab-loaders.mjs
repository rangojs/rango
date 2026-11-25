// SPIKE (keep lab): logs, per painted frame, the navigation state and every
// loader read on screen (visible elements only) through one click script.
//   node scripts/probe-keep-lab-loaders.mjs <mode> [port]

import { chromium } from "@playwright/test";
const [mode, port = "4173"] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage();
const base = `http://localhost:${port}/keep-lab/${mode}`;
await p.goto(`${base}/a`);
await p.waitForSelector("[data-kl-page=a] [data-kl-data]");
await p.waitForSelector("[data-kl-layout-data]");
await p.evaluate(() => {
  window.__log = [];
  let t0 = performance.now();
  let last = "";
  window.__mark = (s) => {
    t0 = performance.now();
    last = "";
    window.__log.push(`- ${s}`);
  };
  const vis = (root, sel) =>
    [...root.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
  const read = (el, attr, loadAttr) =>
    el
      ? "#" +
        el.getAttribute(attr).split(":").pop() +
        (el.getAttribute(loadAttr) === "true" ? "(loading)" : "")
      : "SKELETON";
  const tick = () => {
    const pg = vis(document, "[data-kl-page]");
    const lay = vis(document, '[data-kl-layout-data^="layout:"]');
    const s = [
      `nav=${document.querySelector("[data-kl-nav]")?.textContent}`,
      `layout=${read(lay, "data-kl-layout-data", "data-kl-layout-loading")}`,
      `page=${pg?.dataset.klPage}${pg?.querySelector("[data-kl-instance]")?.textContent}`,
      `data=${read(pg && vis(pg, "[data-kl-data]"), "data-kl-data", "data-kl-loading")}`,
      `page-sees-layout=${read(pg && vis(pg, "[data-kl-layout-data]"), "data-kl-layout-data", "data-kl-layout-loading")}`,
      `url=${location.pathname.split("/").pop()}${location.search}`,
    ].join(" ");
    if (s !== last) {
      last = s;
      window.__log.push(`  +${Math.round(performance.now() - t0)}ms ${s}`);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
async function step(name, sel) {
  await p.evaluate((n) => window.__mark(n), name);
  await p.click(sel);
  await p.waitForTimeout(2600);
}
await step("A -> B (no prefetch)", '[data-kl-link="b-noprefetch"]');
await step("B -> A (no prefetch)", '[data-kl-link="a-noprefetch"]');
await step("A -> B again", '[data-kl-link="b-noprefetch"]');
await step("B -> A?from=b (search)", '[data-kl-link="a-search"]');
await step(
  "Refresh page A's loader",
  '[data-kl-page="a"] [data-kl-refresh="a"]',
);
await step("Refresh layout loader", '[data-kl-refresh="layout"]');
await step("A?from=b -> B (no prefetch)", '[data-kl-link="b-noprefetch"]');
console.log(`## ${mode}`);
console.log((await p.evaluate(() => window.__log)).join("\n"));
await b.close();
