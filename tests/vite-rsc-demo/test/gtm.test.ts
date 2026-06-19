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
  it("takes the last container id (layout sets it) and shallow-merges page child-wins", () => {
    const layout: GtmEntry = {
      containerId: "GTM-LAYOUT",
      page: { path: "/gtm", content_group: "site" },
    };
    const route: GtmEntry = {
      page: { content_group: "demo" },
    };

    const result = collectHandle(Gtm, [[layout], [route]]);

    expect(result.containerId).toBe("GTM-LAYOUT");
    expect(result.page).toEqual({
      path: "/gtm", // from layout
      content_group: "demo", // child overrides
    });
  });

  it("a later container id wins over an earlier one", () => {
    const result = collectHandle(Gtm, [
      [{ containerId: "GTM-A" }],
      [{ containerId: "GTM-B" }],
    ]);
    expect(result.containerId).toBe("GTM-B");
  });

  it("returns empty page and no container when nothing is pushed", () => {
    const result = collectHandle(Gtm, []);
    expect(result).toEqual({ containerId: undefined, page: {} });
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
  it("is deterministic and emits dataLayer init, gtm.js start, page_view, and the loader injection", () => {
    const a = generateGtmInit("GTM-TEST", { path: "/" });
    const b = generateGtmInit("GTM-TEST", { path: "/" });
    expect(a).toBe(b); // byte-identical -> hydration-safe

    expect(a).toContain("window.dataLayer=window.dataLayer||[]");
    expect(a).toContain('event:"gtm.js"');
    expect(a).toContain('event:"page_view"');
    expect(a).toContain('"page_path":"/"');
    // Runtime fields are live expressions, never baked into the string.
    expect(a).toContain("page_location:location.href");
    expect(a).toContain("page_title:document.title");
    expect(a).toContain("page_referrer:document.referrer");
    expect(a).toContain("new Date().getTime()");
    // The loader is injected by the inline script (Google's snippet), keyed by
    // the container id, AFTER dataLayer is initialised.
    expect(a).toContain('"https://www.googletagmanager.com/gtm.js?id="');
    expect(a).toContain('"GTM-TEST"');
    expect(a.indexOf("window.dataLayer=window.dataLayer||[]")).toBeLessThan(
      a.indexOf("gtm.js?id="),
    );
  });

  it("merges static tagging onto the runtime page_view fields", () => {
    const out = generateGtmInit("GTM-TEST", {
      path: "/gtm",
      content_group: "demo",
    });
    expect(out).toContain('"page_path":"/gtm"');
    expect(out).toContain('"content_group":"demo"');
  });

  it("escapes characters that would break out of the <script> element", () => {
    const out = generateGtmInit("GTM-TEST", {
      path: "/x",
      content_group: "</script><b>",
    });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c"); // "<" escaped
  });
});
