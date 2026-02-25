import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

test.describe.configure({ mode: "serial" });

test.describe("MIME type response routes (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("path.json() returns application/json with envelope", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/json"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data).toEqual({ type: "json" });
    expect(body.error).toBeUndefined();
  });

  test("path.text() returns text/plain", async ({ request }) => {
    const response = await request.get(f.url("/test/mime/text"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toBe("hello text");
  });

  test("path.html() returns text/html", async ({ request }) => {
    const response = await request.get(f.url("/test/mime/html"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    const body = await response.text();
    expect(body).toBe("<h1>hello html</h1>");
  });

  test("path.xml() returns application/xml", async ({ request }) => {
    const response = await request.get(f.url("/test/mime/xml"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
    const body = await response.text();
    expect(body).toBe("<root><type>xml</type></root>");
  });

  test("path.image() returns image content-type from handler Response", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/image"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    const body = await response.body();
    // PNG magic bytes
    expect(body[0]).toBe(0x89);
    expect(body[1]).toBe(0x50);
  });

  test("path.stream() returns stream content-type from handler Response", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/stream"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(
      "application/octet-stream",
    );
    const body = await response.text();
    expect(body).toBe("stream data");
  });

  test("path.any() returns custom content-type from handler Response", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/any"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(
      "application/x-custom",
    );
    const body = await response.text();
    expect(body).toBe("custom");
  });

  test("all MIME routes skip RSC pipeline (no Flight content-type)", async ({
    request,
  }) => {
    const paths = [
      "/test/mime/json",
      "/test/mime/text",
      "/test/mime/html",
      "/test/mime/xml",
      "/test/mime/image",
      "/test/mime/stream",
      "/test/mime/any",
    ];
    for (const path of paths) {
      const response = await request.get(f.url(path));
      const contentType = response.headers()["content-type"] || "";
      expect(contentType).not.toContain("text/x-component");
    }
  });

  test("partial request to any MIME route returns X-RSC-Reload", async ({
    request,
  }) => {
    const paths = ["/test/mime/json", "/test/mime/text", "/test/mime/html"];
    for (const path of paths) {
      const response = await request.get(f.url(`${path}?_rsc_partial=1`), {
        headers: { "X-RSC-Router-Client-Path": "/" },
      });
      const reloadHeader = response.headers()["x-rsc-reload"];
      expect(reloadHeader).toBeTruthy();
      expect(reloadHeader).toContain(path);
      expect(reloadHeader).not.toContain("_rsc_partial");
    }
  });
});

test.describe("MIME type response routes (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("path.json() returns application/json in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/json"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data).toEqual({ type: "json" });
  });

  test("path.text() returns text/plain in production", async ({ request }) => {
    const response = await request.get(f.url("/test/mime/text"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const body = await response.text();
    expect(body).toBe("hello text");
  });

  test("path.html() returns text/html in production", async ({ request }) => {
    const response = await request.get(f.url("/test/mime/html"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
  });

  test("path.xml() returns application/xml in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/xml"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
  });

  test("path.image() returns image/png in production", async ({ request }) => {
    const response = await request.get(f.url("/test/mime/image"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  });

  test("path.stream() returns octet-stream in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/stream"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(
      "application/octet-stream",
    );
  });

  test("path.any() returns custom content-type in production", async ({
    request,
  }) => {
    const response = await request.get(f.url("/test/mime/any"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(
      "application/x-custom",
    );
  });
});
