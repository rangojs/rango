import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logging
vi.mock("../browser/logging", () => ({
  debugLog: vi.fn(),
}));

let defaultShouldIntercept: typeof import("../browser/link-interceptor").defaultShouldIntercept;

function setupGlobals(href = "http://localhost/page") {
  const url = new URL(href);
  (globalThis as any).window = {
    location: {
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      href: url.href,
    },
  };
  (globalThis as any).location = (globalThis as any).window.location;
}

function cleanupGlobals() {
  delete (globalThis as any).window;
  delete (globalThis as any).location;
}

/**
 * Create a minimal HTMLAnchorElement-like object for testing.
 * The browser resolves relative hrefs against the document base,
 * so we simulate that by providing pre-resolved properties.
 */
function createLink(
  href: string,
  attrs?: Record<string, string>,
): HTMLAnchorElement {
  const url = new URL(href, "http://localhost");
  return {
    href: url.href,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    target: attrs?.target ?? "",
    hasAttribute(name: string) {
      return name in (attrs ?? {});
    },
    getAttribute(name: string) {
      return attrs?.[name] ?? null;
    },
  } as unknown as HTMLAnchorElement;
}

beforeEach(async () => {
  setupGlobals("http://localhost/page");
  const mod = await import("../browser/link-interceptor");
  defaultShouldIntercept = mod.defaultShouldIntercept;
});

afterEach(() => {
  cleanupGlobals();
  vi.restoreAllMocks();
});

describe("defaultShouldIntercept", () => {
  it("intercepts same-origin links", () => {
    const link = createLink("http://localhost/other");
    expect(defaultShouldIntercept(link)).toBe(true);
  });

  it("does not intercept cross-origin links", () => {
    const link = createLink("http://external.com/page");
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("does not intercept links with download attribute", () => {
    const link = createLink("http://localhost/file.pdf", { download: "" });
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("does not intercept links with target other than _self", () => {
    const link = createLink("http://localhost/other", { target: "_blank" });
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("does not intercept links with data-no-intercept", () => {
    const link = createLink("http://localhost/other", {
      "data-no-intercept": "true",
    });
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("does not intercept links with data-link-component", () => {
    const link = createLink("http://localhost/other", {
      "data-link-component": "",
    });
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("does not intercept links with data-external", () => {
    const link = createLink("http://localhost/other", {
      "data-external": "",
    });
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  // Hash-only navigation tests
  it("does not intercept hash-only links (#section)", () => {
    const link = createLink("http://localhost/page#section");
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("does not intercept same-path hash links (/page#section)", () => {
    setupGlobals("http://localhost/page");
    const link = createLink("http://localhost/page#top");
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("intercepts different-path links even with hash", () => {
    setupGlobals("http://localhost/page");
    const link = createLink("http://localhost/other#section");
    expect(defaultShouldIntercept(link)).toBe(true);
  });

  it("intercepts same-path links without hash (e.g. refresh)", () => {
    setupGlobals("http://localhost/page");
    const link = createLink("http://localhost/page");
    expect(defaultShouldIntercept(link)).toBe(true);
  });

  it("does not intercept hash-only with query string match", () => {
    setupGlobals("http://localhost/page?q=hello");
    const link = createLink("http://localhost/page?q=hello#section");
    expect(defaultShouldIntercept(link)).toBe(false);
  });

  it("intercepts hash links when query string differs", () => {
    setupGlobals("http://localhost/page?q=hello");
    const link = createLink("http://localhost/page?q=world#section");
    expect(defaultShouldIntercept(link)).toBe(true);
  });
});
