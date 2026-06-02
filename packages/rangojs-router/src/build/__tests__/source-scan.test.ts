import { describe, it, expect } from "vitest";
import {
  firstCodeMatchIndex,
  codeMatchIndices,
} from "../route-types/source-scan.js";

// Fresh global regexes per call (firstCodeMatchIndex/codeMatchIndices set
// lastIndex, so each test uses its own instance).
const ROUTER = () => /\bcreateRouter\s*[<(]/g;
const LOADER = () => /\bcreateLoader\s*(?:<[^>]*>\s*)?\(/g;

describe("source-scan: firstCodeMatchIndex", () => {
  it("matches a real call at the token start", () => {
    const code = `export const r = createRouter();`;
    expect(firstCodeMatchIndex(code, ROUTER())).toBe(
      code.indexOf("createRouter"),
    );
  });

  it("ignores a token in a line comment", () => {
    expect(
      firstCodeMatchIndex(`// createRouter() here\nconst x = 1;`, ROUTER()),
    ).toBe(-1);
  });

  it("ignores a token in a (multi-line) block comment", () => {
    expect(
      firstCodeMatchIndex(`/* createRouter(\n  x\n) */ const x = 1;`, ROUTER()),
    ).toBe(-1);
  });

  it("ignores a token in single/double/template strings", () => {
    expect(firstCodeMatchIndex(`const a = "createRouter(1)";`, ROUTER())).toBe(
      -1,
    );
    expect(firstCodeMatchIndex(`const a = 'createRouter(1)';`, ROUTER())).toBe(
      -1,
    );
    expect(firstCodeMatchIndex("const a = `createRouter(1)`;", ROUTER())).toBe(
      -1,
    );
  });

  it("matches a real call even when comment/string mentions precede it", () => {
    const code = `// createRouter() in a comment\nconst doc = "createRouter(x)";\nexport const r = createRouter({});`;
    expect(firstCodeMatchIndex(code, ROUTER())).toBe(
      code.lastIndexOf("createRouter"),
    );
  });

  it("handles escaped quotes inside strings", () => {
    const code = `const s = "a \\" createRouter(x)"; const r = createRouter();`;
    expect(firstCodeMatchIndex(code, ROUTER())).toBe(
      code.lastIndexOf("createRouter"),
    );
  });

  it("matches a generic call", () => {
    const code = `export const L = createLoader<{ x: string }>(async () => 1);`;
    expect(firstCodeMatchIndex(code, LOADER())).toBe(
      code.indexOf("createLoader"),
    );
  });

  it("does not crash on an unterminated string or comment", () => {
    expect(firstCodeMatchIndex(`const s = "createRouter(`, ROUTER())).toBe(-1);
    expect(firstCodeMatchIndex(`/* createRouter(`, ROUTER())).toBe(-1);
  });
});

describe("source-scan: codeMatchIndices", () => {
  it("returns every real call offset, skipping comment/string/import mentions", () => {
    const code = [
      `import { createLoader } from "@rangojs/router";`, // import: no '(' after -> not a call
      `// createLoader(x) in a comment`, // skipped
      `const doc = "createLoader(y)";`, // skipped
      `export const A = createLoader(async () => 1);`, // real
      `export const B = createLoader(async () => 2);`, // real
    ].join("\n");
    const idx = codeMatchIndices(code, LOADER());
    expect(idx.length).toBe(2);
    for (const i of idx) {
      expect(code.slice(i, i + "createLoader".length)).toBe("createLoader");
    }
  });
});

describe("source-scan: line-terminator handling for // comments", () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);

  it("ends a // comment at CR / U+2028 / U+2029 so a following call is found", () => {
    for (const term of ["\r", LS, PS]) {
      const code = `// note${term}const r = createRouter();`;
      expect(firstCodeMatchIndex(code, ROUTER())).toBe(
        code.indexOf("createRouter"),
      );
    }
  });

  it("still hides a token that precedes the terminator", () => {
    expect(firstCodeMatchIndex(`// createRouter(\rok();`, ROUTER())).toBe(-1);
  });
});

describe("source-scan: performance", () => {
  it("stays linear on large many-region input (no O(n^2) regression)", () => {
    // ~720 KB of thousands of tiny comment/string regions, the only real call
    // at the very end (worst case: no early-exit). An O(n^2) scan takes
    // seconds here; the linear scan takes a few ms.
    const body = `// comment line\nconst s = "a string literal";\n`.repeat(
      15000,
    );
    const code = body + `export const r = createRouter();`;
    const t0 = performance.now();
    const first = firstCodeMatchIndex(code, ROUTER());
    const all = codeMatchIndices(code, ROUTER());
    const elapsed = performance.now() - t0;
    expect(first).toBe(code.lastIndexOf("createRouter"));
    expect(all.length).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  });
});

// Reference: the straightforward (allocating) strip-then-match the optimized
// scanner replaces. codeMatchIndices must agree with it on every input where
// the token is atomic (no comment interleaved between callee and "(").
function refStrip(code: string): string {
  const out = code.split("");
  const n = code.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) {
      if (out[j] !== "\n" && out[j] !== "\r") out[j] = " ";
    }
  };
  let i = 0;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      let j = i + 2;
      while (j < n && code[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === c) {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

describe("source-scan: differential vs reference strip-then-match", () => {
  it("agrees with the reference over randomized inputs", () => {
    // Atomic tokens: "createRouter(" never gets a comment inserted between the
    // callee and "(", so the two approaches must produce identical offsets.
    const tokens = [
      "createRouter(",
      "x(",
      "foo ",
      "// c\n",
      "/* c */",
      '"s"',
      "`t`",
      "'q'",
      "\n",
      "; ",
      "()",
      "<T>",
    ];
    let seed = 0x1234_5678;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iter = 0; iter < 1000; iter++) {
      let code = "";
      const len = 3 + Math.floor(rnd() * 40);
      for (let k = 0; k < len; k++) {
        code += tokens[Math.floor(rnd() * tokens.length)];
      }
      const got = codeMatchIndices(code, /\bcreateRouter\s*[<(]/g);
      const expected = [
        ...refStrip(code).matchAll(/\bcreateRouter\s*[<(]/g),
      ].map((m) => m.index);
      expect(got).toEqual(expected);
    }
  });
});
