/**
 * MetaTags hardening:
 * - FIX 16: ld+json serialization must be escaped before dangerouslySetInnerHTML
 *   so a value containing "</script>" cannot close the tag early (XSS / markup
 *   corruption).
 *
 * Under resolve-by-default, meta descriptors are resolved BEFORE MetaTags renders
 * (server-side on the full render, client-side before apply), so MetaTags only
 * ever renders synchronous descriptors via renderMetaDescriptor — there is no
 * async/use() render path to harden anymore.
 */

import { describe, it, expect } from "vitest";
import { renderToReadableStream } from "react-dom/server.edge";
import { renderMetaDescriptor } from "../MetaTags.js";
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

async function renderSync(
  descriptor: MetaDescriptorBase,
  index = 0,
): Promise<string> {
  const stream = await renderToReadableStream(
    <>{renderMetaDescriptor(descriptor, index)}</>,
    {
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
    const html = await renderSync({
      "script:ld+json": { "@type": "Thing", name: "</script>" },
    });

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
