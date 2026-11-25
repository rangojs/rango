import { createLoader, type LoaderContext } from "@rangojs/router";

// SPIKE (keep lab): one loader per page, answering after a 400 ms server
// delay (KEEP_LAB_DELAY_MS overrides it, e.g. 2000 to watch by hand). Each read counts up per mode and page and carries the server time,
// so a screen shows how old the data it draws is.

const SERVER_DELAY_MS = Number(process.env.KEEP_LAB_DELAY_MS ?? 400);
const reads = new Map<string, number>();

export interface KeepLabData {
  page: string;
  read: number;
  at: string;
}

async function answer(page: string, ctx: LoaderContext): Promise<KeepLabData> {
  await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
  const mode = ctx.pathname.split("/")[2] ?? "";
  const key = `${mode}:${page}`;
  const read = (reads.get(key) ?? 0) + 1;
  reads.set(key, read);
  return { page, read, at: new Date().toISOString().slice(11, 23) };
}

// Fetchable (the `true`), so a page's Refresh button can call load().
export const KeepLabALoader = createLoader((ctx) => answer("a", ctx), true);
export const KeepLabBLoader = createLoader((ctx) => answer("b", ctx), true);
export const KeepLabCLoader = createLoader((ctx) => answer("c", ctx), true);
/** On every mode's layout; the layout and each page read it. */
export const KeepLabLayoutLoader = createLoader(
  (ctx) => answer("layout", ctx),
  true,
);
