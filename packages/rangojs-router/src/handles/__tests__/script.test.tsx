// @vitest-environment happy-dom
/**
 * Script handle + <Scripts> renderer.
 *
 * collectScripts (the handle's collect) and escapeScriptBody are pure and tested
 * directly. <Scripts> is tested via renderRoute for the INLINE path only: an
 * external <script src> would make happy-dom attempt a real network load
 * ("JavaScript file loading is disabled"), so the external/async shapes — and the
 * freeze-after-hydration soft-nav contract — are covered by the dev+prod e2e
 * (real browser) instead.
 *
 * Several cases deliberately cast invalid shapes to ScriptConfig: the
 * discriminated union makes them unrepresentable in TypeScript, so they can only
 * arrive from untyped JS callers or malformed serialized input — which is exactly
 * what the runtime dev-warnings guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { collectHandle } from "../../testing/collect-handle.js";
import { renderRoute } from "../../testing/render-route.js";
import { escapeScriptBody } from "../../escape-script.js";
import { Script, type ScriptConfig } from "../script.js";
import { Scripts } from "../Scripts.js";

afterEach(cleanup);

describe("collectScripts (collectHandle)", () => {
  it("dedups by id (last-push-wins) keeping the first position", () => {
    const result = collectHandle(Script, [
      [{ id: "a", children: "v1" }],
      [
        { id: "a", children: "v2" },
        { id: "b", src: "https://x/y.js" },
      ],
    ]);
    expect(result).toEqual([
      { id: "a", children: "v2" },
      { id: "b", src: "https://x/y.js" },
    ]);
  });

  it("falls back to src as the dedup key for external scripts without an id", () => {
    const result = collectHandle(Script, [
      [{ src: "https://x/y.js", async: true }],
      [{ src: "https://x/y.js", defer: true }],
    ]);
    expect(result).toEqual([{ src: "https://x/y.js", defer: true }]);
  });

  it("dedups async resources by src even when ids differ (React dedups by src)", () => {
    const result = collectHandle(Script, [
      [{ id: "a", src: "https://x/y.js", async: true }],
      [{ id: "b", src: "https://x/y.js", async: true }],
    ]);
    // One winner, last-by-src — otherwise React picks one with undefined precedence.
    expect(result).toEqual([{ id: "b", src: "https://x/y.js", async: true }]);
  });

  it("keeps (untyped) inline scripts without an id (cannot dedup)", () => {
    const result = collectHandle(Script, [
      [{ children: "a" } as ScriptConfig],
      [{ children: "b" } as ScriptConfig],
    ]);
    expect(result).toHaveLength(2);
  });

  it("preserves push order across segments (parent -> child)", () => {
    const result = collectHandle(Script, [
      [{ id: "1", children: "a" }],
      [{ id: "2", children: "b" }],
    ]);
    expect(result.map((c) => c.id)).toEqual(["1", "2"]);
  });
});

describe("collectScripts dev warnings (untyped / serialized input)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("warns when both src and children are set", () => {
    collectHandle(Script, [
      [
        {
          id: "x",
          src: "https://x/y.js",
          children: "a",
        } as unknown as ScriptConfig,
      ],
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('both "src" and "children"'),
    );
  });

  it("warns when an inline script has no id", () => {
    collectHandle(Script, [[{ children: "a" } as ScriptConfig]]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('without an "id"'),
    );
  });

  it("warns when async and defer are both set", () => {
    collectHandle(Script, [
      [
        {
          src: "https://x/y.js",
          async: true,
          defer: true,
        } as unknown as ScriptConfig,
      ],
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('both "async" and "defer"'),
    );
  });

  it("warns when neither src nor children is set", () => {
    collectHandle(Script, [[{ id: "x" } as unknown as ScriptConfig]]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('neither "src" nor "children"'),
    );
  });
});

describe("ScriptConfig type-level rejection (verified by tsc --noEmit)", () => {
  it("rejects invalid shapes at compile time", () => {
    // Each literal compiles ONLY because of the @ts-expect-error above it. If the
    // discriminated union ever widens to accept one of these, the directive
    // becomes unused and `tsc --noEmit` (the typecheck gate) fails.
    // @ts-expect-error inline scripts require an `id`
    const noId: ScriptConfig = { children: "x" };
    // @ts-expect-error `src` and `children` are mutually exclusive
    const both: ScriptConfig = { id: "a", src: "x", children: "y" };
    // @ts-expect-error `async` and `defer` are mutually exclusive
    const asyncDefer: ScriptConfig = { src: "x", async: true, defer: true };
    // @ts-expect-error a config needs `src` or `children`
    const empty: ScriptConfig = { id: "a" };
    expect([noId, both, asyncDefer, empty]).toHaveLength(4);
  });
});

describe("escapeScriptBody", () => {
  it("escapes </script> so it cannot close the tag, leaving operators intact", () => {
    const out = escapeScriptBody(`var s = "</script>"; if (a < b && c > d) {}`);
    expect(out).not.toContain("</script>");
    expect(out).toContain("<\\/script>");
    // Real operators are untouched (unlike escapeJsonForScript).
    expect(out).toContain("a < b && c > d");
  });

  it("neutralizes <!-- so <!--<script> cannot enter the double-escaped state", () => {
    const out = escapeScriptBody(`var x = "<!--<script>foo</script>";`);
    // The "<!--" that would start the escaped state is broken (via !)...
    expect(out).not.toContain("<!--");
    expect(out).toContain("<\\u0021--");
    // ...and the literal close tag is still escaped.
    expect(out).not.toContain("</script>");
    expect(out).toContain("<\\/script>");
  });

  it("stays valid JSON and a valid /u regex (the escapes must not be \\! )", () => {
    const escaped = escapeScriptBody(`<!--</script>`);
    // ! / \/ are valid JSON escapes, so a JSON body round-trips.
    expect(JSON.parse(`"${escaped}"`)).toBe("<!--</script>");
    // ...and they are valid in a unicode-mode regex (\! would throw here).
    const re = new RegExp(escaped, "u");
    expect(re.test("<!--</script>")).toBe(true);
  });
});

describe("<Scripts /> (renderRoute, inline path)", () => {
  function seed(configs: ScriptConfig[], position?: "head" | "body") {
    const Probe = () => <Scripts position={position} />;
    return renderRoute([{ path: "/", Component: Probe }], {
      request: "/",
      nonce: "test-nonce",
      handles: [[Script, configs]],
    });
  }

  it("renders an inline script with the request nonce and the body", async () => {
    // Body escaping is covered by the escapeScriptBody test above; happy-dom
    // re-parses <script> innerHTML and mangles the backslash escape, so assert
    // the body presence + nonce here, not the escaped sequence.
    const { container } = await seed([
      { id: "gtm", children: `var gtmReady = 1;` },
    ]);
    const script = container.querySelector("script");
    expect(script).not.toBeNull();
    expect(script!.getAttribute("nonce")).toBe("test-nonce");
    expect(script!.textContent).toContain("gtmReady");
  });

  it("renders only the configs matching the site's position", async () => {
    const head = await seed([
      { id: "h", children: "1" },
      { id: "b", children: "2", position: "body" },
    ]);
    expect(head.container.querySelectorAll("script")).toHaveLength(1);

    const body = await seed(
      [
        { id: "h", children: "1" },
        { id: "b", children: "2", position: "body" },
      ],
      "body",
    );
    expect(body.container.querySelectorAll("script")).toHaveLength(1);
  });

  it("renders the config id as the DOM id (for vendors needing <script id>)", async () => {
    const { container } = await seed([{ id: "gtm-x", children: "0" }]);
    expect(container.querySelector("script")!.getAttribute("id")).toBe("gtm-x");
  });

  it("drops on* event handlers from attributes (cannot cross the boundary)", async () => {
    const { container } = await seed([
      {
        id: "x",
        children: "0",
        attributes: { onLoad: "boom()" },
      } as unknown as ScriptConfig,
    ]);
    expect(
      container.querySelector("script")!.getAttribute("onload"),
    ).toBeNull();
  });

  it("drops managed fields smuggled through attributes (untyped input)", async () => {
    // children/dangerouslySetInnerHTML alongside the inline body would make React
    // throw, and src on an inline script is nonsense — all must be stripped.
    const { container } = await seed([
      {
        id: "x",
        children: "var ok = 1;",
        attributes: {
          src: "https://evil.example/x.js",
          dangerouslySetInnerHTML: { __html: "evil" },
          "data-ok": "1",
        },
      } as unknown as ScriptConfig,
    ]);
    const script = container.querySelector("script")!;
    expect(script.getAttribute("src")).toBeNull();
    expect(script.textContent).toContain("var ok"); // the real inline body
    expect(script.textContent).not.toContain("evil");
    expect(script.getAttribute("data-ok")).toBe("1"); // non-managed survives
  });

  it("forwards passthrough attributes but never the nonce key", async () => {
    // nonce-in-attributes is untyped input (ScriptAttributes excludes nonce).
    const { container } = await seed([
      {
        id: "x",
        children: "0",
        attributes: { "data-domain": "example.com", nonce: "spoofed" },
      } as unknown as ScriptConfig,
    ]);
    const script = container.querySelector("script")!;
    expect(script.getAttribute("data-domain")).toBe("example.com");
    // nonce comes from the request, not the attributes passthrough.
    expect(script.getAttribute("nonce")).toBe("test-nonce");
  });
});
