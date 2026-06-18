/**
 * MetaTags hardening:
 * - FIX 16: ld+json serialization must be escaped before dangerouslySetInnerHTML
 *   so a value containing "</script>" cannot close the tag early (XSS / markup
 *   corruption).
 * - FIX 18: a rejected async meta descriptor must degrade to rendering nothing
 *   instead of throwing during render and crashing the document head.
 *
 * The rendered-behavior checks go through react-dom/server's streaming renderer
 * because the async use(promise) path resolves there exactly as it does in real
 * SSR; a client-only render under happy-dom does not reliably resume a suspended
 * use().
 */

import { describe, it, expect } from "vitest";
import { Suspense } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { AsyncMetaTag } from "../MetaTags.js";
import { escapeJsonForScript } from "../../escape-script.js";
import type { MetaDescriptorBase } from "../../router/types.js";

async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function renderAsync(
  promise: Promise<MetaDescriptorBase>,
  index = 0,
): Promise<string> {
  const stream = await renderToReadableStream(
    <Suspense fallback={null}>
      <AsyncMetaTag promise={promise} index={index} />
    </Suspense>,
    {
      // A rejected descriptor must NOT propagate as a fatal stream error; the
      // promise-level guard should have already neutralized it. Surface any
      // onError so an unexpected throw fails the test loudly.
      onError(error) {
        throw error;
      },
    },
  );
  return streamToString(stream);
}

// FIX 16
describe("escapeJsonForScript", () => {
  it("escapes a serialized payload carrying </script> so the literal tag never appears", () => {
    const value = { name: "</script><script>alert(1)</script>" };
    const escaped = escapeJsonForScript(JSON.stringify(value));

    expect(escaped).not.toContain("</script>");
    expect(escaped).not.toContain("<script>");
    // "<" is replaced with its JSON unicode escape.
    expect(escaped).toContain("\\u003c");
  });

  it("produces output that re-parses to the original object", () => {
    const value = { "@type": "Thing", note: "a < b & c > d </script>" };
    const escaped = escapeJsonForScript(JSON.stringify(value));

    // \uXXXX escapes are legal inside JSON strings, so JSON.parse decodes them
    // back to the original characters.
    expect(JSON.parse(escaped)).toEqual(value);
  });
});

// FIX 16 rendered: the injected ld+json script must not carry a literal
// </script> in the streamed markup.
describe("ld+json rendered injection", () => {
  it("does not emit a literal </script> inside the injected payload", async () => {
    const html = await renderAsync(
      Promise.resolve<MetaDescriptorBase>({
        "script:ld+json": { "@type": "Thing", name: "</script>" },
      }),
    );

    expect(html).toContain('<script type="application/ld+json">');
    // The dangerous closing tag from the value must be escaped, not literal.
    expect(html).toContain("\\u003c/script\\u003e");
    // The ONLY literal </script> is the genuine tag terminator React emits, not
    // one originating inside the payload.
    expect(html.match(/<\/script>/g)?.length).toBe(1);

    // The escaped payload still re-parses to the original object.
    const start = html.indexOf(">", html.indexOf("ld+json")) + 1;
    const end = html.indexOf("</script>", start);
    const payload = html.slice(start, end);
    expect(JSON.parse(payload)).toEqual({
      "@type": "Thing",
      name: "</script>",
    });
  });
});

// FIX 18
describe("AsyncMetaTag rejection handling", () => {
  it("renders nothing and does not throw when the descriptor promise rejects", async () => {
    const rejecting = Promise.reject(new Error("meta failed"));
    // Swallow Node's unhandled-rejection bookkeeping; the component guards it.
    rejecting.catch(() => {});

    const html = await renderAsync(rejecting);

    // No tag and no error fallback marker — just an empty Suspense boundary.
    expect(html).not.toContain("<meta");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    // No "switched to client rendering" recovery template (that marker carries
    // data-msg); the guard neutralizes the rejection before it can surface.
    expect(html).not.toContain("data-msg");
  });

  it("renders the resolved tag when the descriptor promise resolves", async () => {
    const html = await renderAsync(
      Promise.resolve<MetaDescriptorBase>({
        name: "description",
        content: "hello",
      }),
    );

    expect(html).toContain('name="description"');
    expect(html).toContain('content="hello"');
  });
});
