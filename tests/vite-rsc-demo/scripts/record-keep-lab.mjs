// SPIKE (keep lab): records the same click script in every keep-lab mode,
// with a Playwright video per mode and a log of what each painted frame
// shows. Not a test: it asserts nothing. Run it against a running server:
//
//   node scripts/record-keep-lab.mjs http://localhost:4173 ./keep-lab-videos
//
// Each mode gets <out>/<mode>.webm and <out>/<mode>.png (the page after the
// plain link back); the frame log goes to stdout and <out>/frames.txt.

import { chromium } from "@playwright/test";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:4173";
const out = path.resolve(process.argv[3] ?? "keep-lab-videos");
const MODES = ["plain", "transition", "keep", "keep-two-step", "group"];
const SIZE = { width: 1280, height: 960 };
const SETTLE_MS = 1500;

// Runs in the page: one line per painted frame whose state differs from the
// last one, with its time from the step's start.
function installRecorder() {
  const w = window;
  w.__kl = { lines: [], last: "", t0: performance.now(), step: "load" };
  const visiblePage = () =>
    [...document.querySelectorAll("[data-kl-page]")].find(
      (el) => el.offsetParent !== null,
    );
  const snapshot = () => {
    const page = visiblePage();
    const hidden = [...document.querySelectorAll("[data-kl-page]")]
      .filter((el) => el.offsetParent === null)
      .map((el) => el.getAttribute("data-kl-page"))
      .join(",");
    const crumbs = [
      ...document.querySelectorAll('nav[aria-label="Breadcrumb"] li'),
    ].map((li) => li.textContent.replace("/", "").trim());
    if (!page) return `no page | url=${location.pathname}${location.search}`;
    const skeleton = page.querySelector("[data-kl-skeleton]");
    const data = page.querySelector("[data-kl-data]");
    const list = page.querySelector("[data-kl-list]");
    return [
      `page=${page.getAttribute("data-kl-page")}${page.querySelector("[data-kl-instance]")?.textContent ?? ""}`,
      skeleton ? "SKELETON" : `data=${data?.textContent ?? "-"}`,
      `typed=${JSON.stringify(page.querySelector("[data-kl-input]")?.value ?? "")}`,
      `panel=${page.querySelector("[data-kl-panel]") ? "open" : "closed"}`,
      `scroll=${list?.scrollTop ?? "-"}`,
      `hidden=${hidden || "-"}`,
      `title=${JSON.stringify(document.title)}`,
      `crumb=${JSON.stringify(crumbs.at(-1) ?? "")}`,
      `url=${location.pathname}${location.search}`,
    ].join(" | ");
  };
  const tick = () => {
    const now = snapshot();
    if (now !== w.__kl.last) {
      w.__kl.last = now;
      const ms = Math.round(performance.now() - w.__kl.t0);
      w.__kl.lines.push(`  +${String(ms).padStart(5)}ms ${now}`);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function step(page, name, act) {
  await page.evaluate((label) => {
    window.__kl.t0 = performance.now();
    window.__kl.step = label;
    window.__kl.lines.push(`- ${label}`);
    let caption = document.getElementById("kl-caption");
    if (!caption) {
      caption = document.createElement("div");
      caption.id = "kl-caption";
      caption.style.cssText =
        "position:fixed;right:12px;bottom:12px;padding:6px 10px;background:#222;color:#fff;font:14px system-ui;border-radius:6px;z-index:9999";
      document.body.appendChild(caption);
    }
    caption.textContent = label;
  }, name);
  await act();
  await page.waitForTimeout(SETTLE_MS);
}

const click = (page, selector) => () => page.click(selector);

async function record(browser, mode) {
  const dir = path.join(out, `tmp-${mode}`);
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir, size: SIZE },
  });
  await context.addInitScript(installRecorder);
  const page = await context.newPage();
  await page.goto(`${base}/keep-lab/${mode}/a`);
  await page.waitForSelector("[data-kl-page=a] [data-kl-data]");
  // Hydration, then state a remount would lose.
  await page.waitForTimeout(800);
  await page.fill("[data-kl-page=a] [data-kl-input]", "typed on A");
  await page.click("[data-kl-page=a] [data-kl-panel-toggle]");
  await page.$eval("[data-kl-page=a] [data-kl-list]", (el) => {
    el.scrollTop = 300;
  });
  await page.waitForTimeout(800);

  await step(
    page,
    "1. first visit: A -> B (no-prefetch link)",
    click(page, "[data-kl-link=b-noprefetch]"),
  );
  await step(
    page,
    "2. link back, plain: B -> A (no-prefetch link)",
    click(page, "[data-kl-link=a-noprefetch]"),
  );
  await page.screenshot({ path: path.join(out, `${mode}.png`) });
  await step(
    page,
    "3. A -> B again (no-prefetch link)",
    click(page, "[data-kl-link=b-noprefetch]"),
  );
  await step(
    page,
    "4. link back with a search: B -> A?from=b",
    click(page, "[data-kl-link=a-search]"),
  );
  await step(page, "5. Back: A?from=b -> B", () => page.goBack());
  await step(
    page,
    "6. prefetched link back: hover A for 1 s, click",
    async () => {
      await page.hover("[data-kl-link=a]");
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        window.__kl.t0 = performance.now();
        window.__kl.lines.push("  (click)");
      });
      await page.click("[data-kl-link=a]");
    },
  );

  const lines = await page.evaluate(() => window.__kl.lines);
  await context.close();
  const [video] = await readdir(dir);
  await rename(path.join(dir, video), path.join(out, `${mode}.webm`));
  await rm(dir, { recursive: true, force: true });
  return [`## ${mode}`, ...lines].join("\n");
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const logs = [];
try {
  for (const mode of MODES) {
    const log = await record(browser, mode);
    console.log(log);
    logs.push(log);
  }
} finally {
  await browser.close();
}
await writeFile(path.join(out, "frames.txt"), `${logs.join("\n\n")}\n`);
