import { describe, expect, it } from "vitest";
import { collectHandle } from "@rangojs/router/testing";
import {
  Gtm,
  generateGtmInit,
  pageViewTagging,
  type GtmEntry,
} from "../src/handles/gtm.js";

/**
 * Dogfood the GTM handle through the public @rangojs/router/testing primitive
 * (collectHandle), the same way a consumer would, plus the pure script builders.
 * Pins the consumer-visible contract: the layout sets the container id and page
 * path; a nested route merges extra page tagging on top; the inline init stays
 * deterministic and HTML-safe and emits the GA4-recommended page_view fields.
 */

describe("Gtm handle — collectGtm (collectHandle)", () => {
  it("shallow-merges page across segments, child wins", () => {
    const layout: GtmEntry = { page: { path: "/gtm", content_group: "site" } };
    const route: GtmEntry = { page: { content_group: "demo" } };

    const result = collectHandle(Gtm, [[layout], [route]]);

    expect(result.page).toEqual({
      path: "/gtm", // from layout
      content_group: "demo", // child overrides
    });
  });

  it("returns an empty page when nothing is pushed", () => {
    expect(collectHandle(Gtm, [])).toEqual({ page: {} });
  });
});

describe("pageViewTagging", () => {
  it("maps path -> page_path and passes extras through", () => {
    expect(pageViewTagging({ path: "/gtm", content_group: "demo" })).toEqual({
      page_path: "/gtm",
      content_group: "demo",
    });
  });

  it("omits page_path when path is absent", () => {
    expect(pageViewTagging({})).toEqual({});
  });

  it("drops reserved keys so extras cannot override framework-owned fields", () => {
    expect(
      pageViewTagging({
        path: "/gtm",
        content_group: "demo",
        event: "hacked",
        page_title: "spoofed",
        page_location: "evil",
        page_referrer: "evil",
        page_path: "spoofed",
      }),
    ).toEqual({ page_path: "/gtm", content_group: "demo" });
  });
});

describe("generateGtmInit", () => {
  it("emits dataLayer init, gtm.js start, a runtime page_view, and the loader injection", () => {
    const a = generateGtmInit("GTM-TEST");

    expect(a).toContain("window.dataLayer=window.dataLayer||[]");
    expect(a).toContain('event:"gtm.js"');
    expect(a).toContain('event:"page_view"');
    // All page_view fields are live runtime expressions (the bootstrap is
    // request-shape-independent so a server component renders it identically).
    expect(a).toContain("page_location:location.href");
    expect(a).toContain("page_path:location.pathname+location.search");
    expect(a).toContain("page_title:document.title");
    expect(a).toContain("page_referrer:document.referrer");
    expect(a).toContain("new Date().getTime()");
    // The loader is injected by the inline script, keyed by the container id,
    // AFTER dataLayer is initialised.
    expect(a).toContain('"https://www.googletagmanager.com/gtm.js?id="');
    expect(a).toContain('"GTM-TEST"');
    expect(a.indexOf("window.dataLayer=window.dataLayer||[]")).toBeLessThan(
      a.indexOf("gtm.js?id="),
    );
  });

  it("bakes `extras` (e.g. content_group) onto the first page_view server-side", () => {
    const out = generateGtmInit("GTM-TEST", { content_group: "demo" });
    expect(out).toContain('"content_group":"demo"');
    // Merged onto the runtime fields via Object.assign, not replacing them.
    expect(out).toContain("page_location:location.href");
    expect(out).toContain("Object.assign(");
  });

  it("omits the Object.assign wrapper when there are no extras", () => {
    expect(generateGtmInit("GTM-TEST")).not.toContain("Object.assign(");
  });

  it("strips reserved keys from extras so they cannot override runtime fields", () => {
    const out = generateGtmInit("GTM-TEST", {
      event: "hacked",
      page_path: "spoofed",
      page_title: "spoofed",
      content_group: "demo",
    });
    // The framework-owned fields keep their runtime expressions...
    expect(out).toContain('event:"page_view"');
    expect(out).toContain("page_path:location.pathname+location.search");
    expect(out).toContain("page_title:document.title");
    // ...and the reserved keys never make it into the baked extras.
    expect(out).not.toContain('"event":"hacked"');
    expect(out).not.toContain('"page_path":"spoofed"');
    expect(out).not.toContain('"page_title":"spoofed"');
    // Non-reserved extras are still baked.
    expect(out).toContain('"content_group":"demo"');
  });

  it("emits raw JS (no manual escaping) — <Scripts/> escapes </script> at render", () => {
    // generateGtmInit does not escape; the router's <Scripts/> applies
    // escapeScriptBody when it renders the inline body (covered by the router's
    // handles/__tests__/script.test.tsx). So the builder stays a plain snippet.
    const out = generateGtmInit("GTM-TEST", { content_group: "demo" });
    expect(out).toContain('{"content_group":"demo"}');
  });
});
