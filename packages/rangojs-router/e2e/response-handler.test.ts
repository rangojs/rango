import test, { expect } from "@playwright/test";
import { useFixture } from "./fixture";

test.describe("response-handler", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.describe("string auto-wrap", () => {
    test("path.md() auto-wraps string with text/markdown content-type", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/auto?q=hello"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("# Auto-wrapped");
      expect(body).toContain("Param: hello");
    });

    test("path.text() auto-wraps string with text/plain content-type", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/text"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/plain");
      expect(await res.text()).toBe("plain text response");
    });

    test("path.html() auto-wraps string with text/html content-type", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/html"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
      expect(await res.text()).toBe("<h1>html response</h1>");
    });

    test("path.xml() auto-wraps string with application/xml content-type", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/xml"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/xml");
      expect(await res.text()).toBe("<root>xml</root>");
    });
  });

  test.describe("ctx.header() on auto-wrapped responses", () => {
    test("md handler can set custom headers via ctx.header()", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/with-headers"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      expect(res.headers()["x-custom"]).toBe("from-md-handler");
      expect(res.headers()["cache-control"]).toBe("public, max-age=3600");
      const body = await res.text();
      expect(body).toContain("# With Headers");
    });

    test("json handler can set custom headers via ctx.header()", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/json-headers"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      expect(res.headers()["x-api-version"]).toBe("v2");
      const body = await res.json();
      expect(body.data.source).toBe("json");
      expect(body.data.version).toBe(2);
    });

    test("text handler can set custom headers via ctx.header()", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/text"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-text-custom"]).toBe("hello");
    });
  });

  test.describe("cookies().set() on auto-wrapped responses", () => {
    test("md handler can set cookies via cookies().set()", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/with-headers"));
      expect(res.status()).toBe(200);
      const setCookie = res.headers()["set-cookie"];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("md-visited=true");
    });

    test("json handler can set cookies via cookies().set()", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/json-headers"));
      expect(res.status()).toBe(200);
      const setCookie = res.headers()["set-cookie"];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("api-session=abc123");
      expect(setCookie).toContain("HttpOnly");
    });
  });

  test.describe("Response pass-through", () => {
    test("returning Response directly preserves custom headers", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-wrap/custom-response"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      expect(res.headers()["cache-control"]).toBe("public, max-age=3600");
      expect(res.headers()["x-custom"]).toBe("hello");
      const body = await res.text();
      expect(body).toContain("# Custom");
    });
  });

  test.describe("nested middleware on response routes", () => {
    test("outer middleware sets variable, inner middleware reads it and sets its own", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      const body = await res.json();
      // Handler reads variables set by both middleware layers
      expect(body.data.outer).toBe("outer-value");
      expect(body.data.inner).toBe("inner-saw-outer-value");
    });

    test("both middleware headers are present on the response", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-outer-mw"]).toBe("applied");
      expect(res.headers()["x-inner-mw"]).toBe("applied");
    });

    test("outer middleware runs after handler (post-next header)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-outer-after"]).toBe("after-handler");
    });

    test("middleware can set cookies on response route", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-mw/md-with-mw"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("Role: admin");
      const setCookie = res.headers()["set-cookie"];
      expect(setCookie).toContain("mw-role=admin");
    });

    test("global middleware still applies to response routes", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      // Global middleware sets X-Global-Middleware on all routes
      expect(res.headers()["x-global-middleware"]).toBe("applied");
    });
  });

  test.describe("response routes inside layout", () => {
    test("path.json() inside layout returns JSON (layout is skipped)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-in-layout"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.data.source).toBe("json-in-layout");
    });

    test("path.md() inside layout returns markdown (layout is skipped)", async ({
      request,
    }) => {
      const res = await request.get(f.url("/response-in-layout-md"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toBe("# MD in Layout");
      // No HTML wrapper from layout - just raw markdown
      expect(body).not.toContain("LAYOUT");
      expect(body).not.toContain("<div");
    });
  });
});

// ============================================================================
// Production build
// ============================================================================

test.describe("response-handler (production)", () => {
  const fBuild = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.describe("string auto-wrap", () => {
    test("path.md() auto-wraps string with text/markdown content-type", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/auto?q=hello"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("# Auto-wrapped");
      expect(body).toContain("Param: hello");
    });

    test("path.text() auto-wraps string with text/plain content-type", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/text"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/plain");
      expect(await res.text()).toBe("plain text response");
    });

    test("path.html() auto-wraps string with text/html content-type", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/html"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
      expect(await res.text()).toBe("<h1>html response</h1>");
    });

    test("path.xml() auto-wraps string with application/xml content-type", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/xml"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/xml");
      expect(await res.text()).toBe("<root>xml</root>");
    });
  });

  test.describe("ctx.header() on auto-wrapped responses", () => {
    test("md handler can set custom headers via ctx.header()", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/with-headers"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      expect(res.headers()["x-custom"]).toBe("from-md-handler");
      expect(res.headers()["cache-control"]).toBe("public, max-age=3600");
      const body = await res.text();
      expect(body).toContain("# With Headers");
    });

    test("json handler can set custom headers via ctx.header()", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/json-headers"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      expect(res.headers()["x-api-version"]).toBe("v2");
      const body = await res.json();
      expect(body.data.source).toBe("json");
      expect(body.data.version).toBe(2);
    });

    test("text handler can set custom headers via ctx.header()", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/text"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-text-custom"]).toBe("hello");
    });
  });

  test.describe("cookies().set() on auto-wrapped responses", () => {
    test("md handler can set cookies via cookies().set()", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/with-headers"));
      expect(res.status()).toBe(200);
      const setCookie = res.headers()["set-cookie"];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("md-visited=true");
    });

    test("json handler can set cookies via cookies().set()", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-wrap/json-headers"));
      expect(res.status()).toBe(200);
      const setCookie = res.headers()["set-cookie"];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("api-session=abc123");
      expect(setCookie).toContain("HttpOnly");
    });
  });

  test.describe("Response pass-through", () => {
    test("returning Response directly preserves custom headers", async ({
      request,
    }) => {
      const res = await request.get(
        fBuild.url("/response-wrap/custom-response"),
      );
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      expect(res.headers()["cache-control"]).toBe("public, max-age=3600");
      expect(res.headers()["x-custom"]).toBe("hello");
      const body = await res.text();
      expect(body).toContain("# Custom");
    });
  });

  test.describe("nested middleware on response routes", () => {
    test("outer middleware sets variable, inner middleware reads it and sets its own", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.data.outer).toBe("outer-value");
      expect(body.data.inner).toBe("inner-saw-outer-value");
    });

    test("both middleware headers are present on the response", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-outer-mw"]).toBe("applied");
      expect(res.headers()["x-inner-mw"]).toBe("applied");
    });

    test("outer middleware runs after handler (post-next header)", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-outer-after"]).toBe("after-handler");
    });

    test("middleware can set cookies on response route", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-mw/md-with-mw"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toContain("Role: admin");
      const setCookie = res.headers()["set-cookie"];
      expect(setCookie).toContain("mw-role=admin");
    });

    test("global middleware still applies to response routes", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-mw/nested"));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-global-middleware"]).toBe("applied");
    });
  });

  test.describe("response routes inside layout", () => {
    test("path.json() inside layout returns JSON (layout is skipped)", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-in-layout"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("application/json");
      const body = await res.json();
      expect(body.data.source).toBe("json-in-layout");
    });

    test("path.md() inside layout returns markdown (layout is skipped)", async ({
      request,
    }) => {
      const res = await request.get(fBuild.url("/response-in-layout-md"));
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/markdown");
      const body = await res.text();
      expect(body).toBe("# MD in Layout");
      expect(body).not.toContain("LAYOUT");
      expect(body).not.toContain("<div");
    });
  });
});
