// SPIKE (keep lab): logs, per painted frame, what the @panel slot and the
// @modal intercept show (visible elements only) through one click script.
//   node scripts/probe-keep-lab-slots.mjs <mode> [port]

import { chromium } from "@playwright/test";

const [mode, port = "4173"] = process.argv.slice(2);
const wait = Number(process.env.PROBE_WAIT_MS ?? 1500);
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`http://localhost:${port}/keep-lab/${mode}/a`);
await p.waitForSelector("[data-kl-panel-slot] [data-kl-slot-data]");
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
  const slot = (el) => {
    if (!el) return "none";
    const inst = el.querySelector("[data-kl-slot-instance]")?.textContent;
    const sk = vis(el, "[data-kl-slot-skeleton]");
    const d = vis(el, "[data-kl-slot-data]");
    const data = sk
      ? "SKELETON"
      : d
        ? "#" +
          d.dataset.klSlotData.split(":").pop() +
          (d.dataset.klSlotLoading === "true" ? "(loading)" : "")
        : "-";
    const count = el.querySelector("[data-kl-panel-count]")?.textContent;
    const note = el.querySelector("[data-kl-modal-input]")?.value;
    return `${inst} ${data}${count ? ` "${count}"` : ""}${note !== undefined ? ` note=${JSON.stringify(note)}` : ""}`;
  };
  const tick = () => {
    const panel = vis(document, "[data-kl-panel-slot]");
    const modal = [...document.querySelectorAll("[data-kl-modal]")].find(
      (e) =>
        (getComputedStyle(e).display !== "none" && e.offsetParent !== null) ||
        e.getClientRects().length,
    );
    const s = [
      `url=${location.pathname.split("/").slice(3).join("/")}`,
      `panel=${panel ? panel.dataset.klPanelSlot + slot(panel) : "none"}`,
      `modal=${modal ? "item" + modal.dataset.klModal + slot(modal) : "none"}`,
    ].join(" ");
    if (s !== last) {
      last = s;
      window.__log.push(`  +${Math.round(performance.now() - t0)}ms ${s}`);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
async function step(name, action) {
  await p.evaluate((n) => window.__mark(n), name);
  await action();
  await p.waitForTimeout(wait);
}
const click = (sel) => () => p.click(sel);
await step("click the panel's button on A", click("[data-kl-panel-count]"));
await step("A -> C (no panel on C)", click('[data-kl-link="c-noprefetch"]'));
await step("C -> A", click('[data-kl-link="a-noprefetch"]'));
await step("open item 1", click('[data-kl-link="item-1"]'));
await step("type a note", () =>
  p.fill('[data-kl-modal="1"] [data-kl-modal-input]', "note on 1"),
);
await step("close (Back)", click('[data-kl-modal="1"] [data-kl-modal-close]'));
await step("open item 2", click('[data-kl-link="item-2"]'));
await step("close (Back)", click('[data-kl-modal="2"] [data-kl-modal-close]'));
await step("open item 1 again", click('[data-kl-link="item-1"]'));
console.log(`## ${mode}`);
console.log((await p.evaluate(() => window.__log)).join("\n"));
await b.close();
