import { describe, it, expect, vi } from "vitest";
import { onwarn } from "../utils/shared-utils.js";
import type * as Vite from "vite";

// Helper: run onwarn with a spy defaultHandler and report whether the warning
// was suppressed (defaultHandler NOT called) or passed through.
function suppressed(warning: Partial<Vite.Rollup.RollupLog>): boolean {
  const handler = vi.fn();
  onwarn(warning as Vite.Rollup.RollupLog, handler);
  return handler.mock.calls.length === 0;
}

// IMPORTANT: the FILE_NAME_CONFLICT message handed to a user onwarn is Vite's
// DISPLAY string, not rollup's raw log. Vite (a) prefixes it with an ANSI color
// sequence + a "[CODE] " label and (b) strips the quotes rollup puts around the
// filename. The realistic delivered form is therefore PREFIXED + UNQUOTED:
//   "[33m[FILE_NAME_CONFLICT] [0mThe emitted file assets/index-DlGNrvnU.css overwrites ..."
// Tests default to that form so they mirror a real build. Earlier cuts of this
// fix matched a "^"-anchored, quotes-required regex that this form silently
// defeated (the code-gate passed but the message never matched), so every
// conflict leaked through.
const VITE_PREFIX = "[33m[FILE_NAME_CONFLICT] [0m";
const conflictBody = (fileName: string, quoted: boolean) =>
  `The emitted file ${quoted ? `"${fileName}"` : fileName} overwrites a previously emitted file of the same name.`;
const conflict = (
  fileName: string,
  {
    prefixed = true,
    quoted = false,
  }: { prefixed?: boolean; quoted?: boolean } = {},
): Partial<Vite.Rollup.RollupLog> => ({
  code: "FILE_NAME_CONFLICT",
  message: (prefixed ? VITE_PREFIX : "") + conflictBody(fileName, quoted),
});

describe("onwarn: FILE_NAME_CONFLICT (content-hashed asset duplicate emit)", () => {
  // @vitejs/plugin-rsc copies the rsc environment's imported CSS/font assets into
  // the client bundle, re-emitting an already-present content-hashed file ->
  // rollup FILE_NAME_CONFLICT. The name being content-hashed proves the bytes are
  // identical, so these are suppressed.
  it("suppresses a content-hashed CSS collision (real Vite form: prefixed + unquoted)", () => {
    expect(suppressed(conflict("assets/index-DlGNrvnU.css"))).toBe(true);
  });

  it("suppresses a content-hashed woff2 font collision (real Vite form)", () => {
    expect(
      suppressed(conflict("assets/inter-latin-wght-normal-Dx4kXJAl.woff2")),
    ).toBe(true);
  });

  it("suppresses a hash distinguished by a digit only", () => {
    expect(suppressed(conflict("assets/chunk-1a2b3c4d.js"))).toBe(true);
  });

  // Vite/rolldown hashes are base64url, so the fixed-length hash can itself
  // contain "-" or "_". Splitting on the last "-" used to land INSIDE the hash
  // and miss these (the survivors in the real-app re-test).
  it("suppresses hashes that contain '-' or '_' (base64url)", () => {
    expect(
      suppressed(
        conflict(
          "assets/playfair-display-vietnamese-wght-normal-Cabi7G8-.woff2",
        ),
      ),
      "hash ending in '-'",
    ).toBe(true);
    expect(
      suppressed(conflict("assets/inter-greek-wght-normal-CkhJZR-_.woff2")),
      "hash with internal '-' and trailing '_'",
    ).toBe(true);
    expect(
      suppressed(conflict("assets/index-B0p7e-xX.js")),
      "hash with internal '-'",
    ).toBe(true);
  });

  // The matcher must also handle rollup's RAW message (no Vite prefix, quoted
  // filename) and the prefixed-but-quoted shape, in case a Vite version differs.
  it("suppresses the raw rollup form (unprefixed + quoted)", () => {
    expect(
      suppressed(
        conflict("assets/index-DlGNrvnU.css", {
          prefixed: false,
          quoted: true,
        }),
      ),
    ).toBe(true);
  });

  it("suppresses the prefixed + quoted shape", () => {
    expect(
      suppressed(conflict("assets/index-DlGNrvnU.css", { quoted: true })),
    ).toBe(true);
  });

  // Narrowness: a collision on a STABLE (non-content-hashed) name could be a
  // genuine different-content overwrite and must still reach the default handler.
  it("passes through a collision on a stable, unhashed name", () => {
    expect(suppressed(conflict("assets/manifest.json"))).toBe(false);
  });

  it("passes through a hyphenated but all-lowercase (non-hash) name", () => {
    // "skeleton" is 8 chars but has no uppercase/digit -> not a content hash.
    expect(suppressed(conflict("assets/loading-skeleton.css"))).toBe(false);
  });

  it("passes through a short final segment that cannot be a hash", () => {
    expect(suppressed(conflict("assets/style.css"))).toBe(false);
  });

  it("passes through a FILE_NAME_CONFLICT with an unparseable message", () => {
    expect(
      suppressed({ code: "FILE_NAME_CONFLICT", message: "something else" }),
    ).toBe(false);
  });
});

describe("onwarn: existing suppressions remain intact", () => {
  it.each([
    "MODULE_LEVEL_DIRECTIVE",
    "SOURCEMAP_ERROR",
    "EMPTY_BUNDLE",
    "INEFFECTIVE_DYNAMIC_IMPORT",
  ])("suppresses %s", (code) => {
    expect(suppressed({ code, message: "x" })).toBe(true);
  });

  it("suppresses the plugin-rsc 'Sourcemap is likely to be incorrect' message", () => {
    expect(
      suppressed({
        code: "SOURCEMAP_BROKEN",
        message: "Sourcemap is likely to be incorrect: a plugin ...",
      }),
    ).toBe(true);
  });

  it("suppresses the vite:reporter dynamic-import message", () => {
    expect(
      suppressed({
        plugin: "vite:reporter",
        message:
          "/x.js is dynamically imported but also statically imported, dynamic import will not move module into another chunk",
      }),
    ).toBe(true);
  });
});

describe("onwarn: unrelated warnings pass through", () => {
  it.each(["CIRCULAR_DEPENDENCY", "UNRESOLVED_IMPORT", "PLUGIN_WARNING"])(
    "passes through %s",
    (code) => {
      expect(suppressed({ code, message: "real warning" })).toBe(false);
    },
  );
});
