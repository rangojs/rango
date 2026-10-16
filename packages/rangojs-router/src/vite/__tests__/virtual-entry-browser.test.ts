// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIRTUAL_ENTRY_BROWSER } from "../plugins/virtual-entries.js";

// dc-t93: a server render that failed its shell answers a recovery document
// (ssr/shell-error-document.tsx) marked `data-rango-ssr-error`. The entry
// renders that document with createRoot; every other document is hydrated.
// The entry runs here with its imports replaced by spies.

interface EntryRun {
  createRoot: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  hydrateRoot: ReturnType<typeof vi.fn>;
}

async function runEntry(formState?: unknown): Promise<EntryRun> {
  const render = vi.fn();
  const createRoot = vi.fn(() => ({ render }));
  const hydrateRoot = vi.fn();
  const body = VIRTUAL_ENTRY_BROWSER.replace(/^import[\s\S]*?;\n/gm, "")
    .replaceAll("import.meta.hot", "undefined")
    .replace(
      "initializeApp().catch(console.error);",
      "return initializeApp();",
    );
  const scope = {
    createFromReadableStream: vi.fn(),
    createFromFetch: vi.fn(),
    setServerCallback: vi.fn(),
    encodeReply: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
    createElement: (type: unknown, props: unknown, child?: unknown) => ({
      type,
      props,
      child,
    }),
    StrictMode: "StrictMode",
    createRoot,
    hydrateRoot,
    rscStream: {},
    initBrowserApp: vi.fn(async () => ({
      strictMode: false,
      initialPayload: { formState },
    })),
    Rango: "Rango",
  };
  const run = new Function(
    ...Object.keys(scope),
    `return (async () => {\n${body}\n})();`,
  ) as (...args: unknown[]) => Promise<void>;
  await run(...Object.values(scope));
  return { createRoot, render, hydrateRoot };
}

afterEach(() => {
  document.documentElement.removeAttribute("data-rango-ssr-error");
});

describe("virtual browser entry: the recovery document", () => {
  it("renders a document marked data-rango-ssr-error with createRoot, and does not hydrate it", async () => {
    document.documentElement.setAttribute("data-rango-ssr-error", "");

    const { createRoot, render, hydrateRoot } = await runEntry();

    expect(createRoot).toHaveBeenCalledWith(document);
    expect(render).toHaveBeenCalledWith({
      type: "Rango",
      props: undefined,
      child: undefined,
    });
    expect(hydrateRoot).not.toHaveBeenCalled();
  });

  it("hydrates every other document, with the form state", async () => {
    const { createRoot, hydrateRoot } = await runEntry({ step: 1 });

    expect(createRoot).not.toHaveBeenCalled();
    expect(hydrateRoot).toHaveBeenCalledWith(
      document,
      { type: "Rango", props: undefined, child: undefined },
      { formState: { step: 1 } },
    );
  });
});
