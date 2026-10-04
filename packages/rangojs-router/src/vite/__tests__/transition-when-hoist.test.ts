import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath, transformWithOxc } from "vite";
import {
  hoistTransitionWhens,
  isServerOnlySpecifier,
  parseHoistedWhenId,
  transitionWhenHoistPlugin,
} from "../plugins/transition-when-hoist.js";

const FILE = "/app/src/urls.tsx";
const R = 'import { urls } from "@rangojs/router";\n';

async function hoist(
  code: string,
  deps?: Parameters<typeof hoistTransitionWhens>[2],
  file: string = FILE,
) {
  return hoistTransitionWhens(code, file, deps);
}

async function hoistError(
  code: string,
  deps?: Parameters<typeof hoistTransitionWhens>[2],
): Promise<Error> {
  try {
    await hoist(code, deps);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the hoist to throw");
}

/** The emitted module compiles as the id's language (types erased). */
async function compiled(module: string, file: string = FILE): Promise<string> {
  return (await transformWithOxc(module, file, { jsx: "preserve" })).code;
}

describe("hoistTransitionWhens", () => {
  it("hoists a function literal into a use client module and imports it back", async () => {
    const result = await hoist(`import { urls } from "@rangojs/router";
export const patterns = urls(({ path, transition }) => [
  path("/p/:tab", Page, { name: "p" }, () => [
    transition({ enter: "fade", when: (ctx) => ctx.to.params.tab !== "raw" }),
  ]),
]);
`);
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      `import { __rango_when as __rango_when_0 } from "${FILE}?rango-when=0";`,
    );
    expect(result!.code).toContain(
      'transition({ enter: "fade", when: __rango_when_0 })',
    );
    expect(result!.modules).toEqual([
      `"use client";
export const __rango_when = (ctx) => ctx.to.params.tab !== "raw";
`,
    ]);
  });

  it("numbers several literals and keeps the directive prologue first", async () => {
    const result = await hoist(`"use strict";
${R}urls(({ path, transition }) => [
  transition({ when: function first() { return true; } }, () => [
    path("/a", A, () => [transition({ when: () => false })]),
  ]),
]);
`);
    expect(
      result!.code.startsWith(
        '"use strict";\nimport { __rango_when as __rango_when_0 }',
      ),
    ).toBe(true);
    expect(result!.code).toContain("__rango_when_1");
    expect(result!.modules[0]).toContain(
      "export const __rango_when = function first() { return true; };",
    );
    expect(result!.modules[1]).toContain(
      "export const __rango_when = () => false;",
    );
  });

  it("re-emits the imports the literal references (types as import type)", async () => {
    const result =
      await hoist(`import { urls, type TransitionWhenContext } from "@rangojs/router";
import { TxState } from "./location-states.js";
import * as Flags from "./flags.js";
import unused from "./unused.js";
urls(({ path, transition }) => [
  path("/p", Page, () => [
    transition({
      when: (ctx: TransitionWhenContext): boolean =>
        TxState.read(ctx.to)?.animate !== false && Flags.enabled,
    }),
  ]),
]);
`);
    const module = result!.modules[0]!;
    expect(module).toContain(
      'import type { TransitionWhenContext } from "@rangojs/router";',
    );
    expect(module).toContain('import { TxState } from "./location-states.js";');
    expect(module).toContain('import * as Flags from "./flags.js";');
    expect(module).not.toContain("unused");
    expect(module).not.toContain("urls");
  });

  it("allows globals, the literal's own bindings, and shadowing", async () => {
    const result = await hoist(`${R}const limit = 3;
urls(({ path, transition }) => [
  path("/p", Page, () => [
    transition({
      when: (ctx) => {
        const limit = Number(new URL(ctx.to.url).searchParams.get("n"));
        return typeof window !== "undefined" && limit < 10;
      },
    }),
  ]),
]);
`);
    expect(result!.modules).toHaveLength(1);
  });

  it("rejects a capture of a module binding, naming the variable and location", async () => {
    const error = await hoistError(`${R}const threshold = 5;
urls(({ path, transition }) => [
  path("/p", Page, () => [
    transition({ when: (ctx) => Number(ctx.to.params.n) > threshold }),
  ]),
]);
`);
    expect(error.name).toBe("TransitionWhenError");
    expect(error.message).toContain(`${FILE}:5:`);
    expect(error.message).toContain(
      "`when` runs in the browser; `threshold` is a server-module binding. Read it from `to.params`/`to.state`",
    );
  });

  it("rejects a capture of an enclosing function's binding", async () => {
    const error = await hoistError(`${R}urls(({ path, transition }) => {
  const section = "shop";
  return [
    path("/p", Page, () => [
      transition({ when: (ctx) => ctx.to.url.pathname.startsWith(section) }),
    ]),
  ];
});
`);
    expect(error.message).toContain("`section` is a server-module binding");
  });

  it("rejects a server-only import, naming it", async () => {
    const error = await hoistError(`${R}import { readFileSync } from "node:fs";
urls(({ path, transition }) => [
  path("/p", Page, () => [transition({ when: () => !!readFileSync })]),
]);
`);
    expect(error.message).toContain(
      '`readFileSync` is imported from "node:fs", a server-only module.',
    );

    await expect(
      hoist(
        `${R}import { db } from "./db.js";
urls(({ path, transition }) => [
  path("/p", Page, () => [transition({ when: () => db.ok })]),
]);
`,
        { isServerOnlyImport: (source) => source === "./db.js" },
      ),
    ).rejects.toThrow('`db` is imported from "./db.js", a server-only module.');
  });

  it("accepts an identifier that is an import (discovery checks it is a client reference)", async () => {
    expect(
      await hoist(`${R}import { holdWhen } from "./transitions.js";
urls(({ path, transition }) => [
  path("/p", Page, () => [transition({ when: holdWhen })]),
]);
`),
    ).toBeNull();
  });

  it("rejects an identifier that is a local binding", async () => {
    const error = await hoistError(`${R}function holdWhen() { return true; }
urls(({ path, transition }) => [
  path("/p", Page, () => [transition({ when: holdWhen })]),
]);
`);
    expect(error.message).toContain(
      '`holdWhen` is a server-module binding. Export the predicate from a "use client" module',
    );
  });

  it("leaves a use client module (clientUrls) alone", async () => {
    expect(
      await hoist(`"use client";
const limit = 3;
export default clientUrls(({ path, transition }) => [
  path("/p", Page, () => [transition({ when: () => limit > 1 })]),
]);
`),
    ).toBeNull();
  });
});

describe("hoistTransitionWhens: method shorthand and accessors", () => {
  it("hoists a `when() {}` method as a function expression", async () => {
    const result = await hoist(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when() { return true; } })]),
]);
`);
    expect(result).not.toBeNull();
    expect(result!.code).toContain("transition({ when: __rango_when_0 })");
    expect(result!.modules[0]).toBe(`"use client";
export const __rango_when = function () { return true; };
`);
    await compiled(result!.modules[0]!);
    await compiled(result!.code);
  });

  it("keeps async/generator flags and neighbouring properties", async () => {
    const result = await hoist(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [
    transition({ enter: "fade", async when(ctx) { return ctx.to.params.n !== "b"; }, leave: "x" }),
  ]),
  path("/b", B, () => [transition({ *when() { yield 1; } })]),
  path("/c", C, () => [transition({ when: () => false })]),
]);
`);
    expect(result!.code).toContain(
      'transition({ enter: "fade", when: __rango_when_0, leave: "x" })',
    );
    expect(result!.code).toContain("transition({ when: __rango_when_1 })");
    expect(result!.code).toContain("transition({ when: __rango_when_2 })");
    expect(result!.modules[0]).toContain(
      'export const __rango_when = async function (ctx) { return ctx.to.params.n !== "b"; };',
    );
    expect(result!.modules[1]).toContain(
      "export const __rango_when = function* () { yield 1; };",
    );
    expect(result!.modules[2]).toContain(
      "export const __rango_when = () => false;",
    );
    for (const module of result!.modules) await compiled(module);
    await compiled(result!.code);
  });

  it("rejects a getter or setter `when`", async () => {
    const getter = await hoistError(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ get when() { return () => true; } })]),
]);
`);
    expect(getter.name).toBe("TransitionWhenError");
    expect(getter.message).toContain("`get when()` is an accessor");

    const setter = await hoistError(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ set when(v) {} })]),
]);
`);
    expect(setter.name).toBe("TransitionWhenError");
    expect(setter.message).toContain("`set when()` is an accessor");
  });
});

describe("hoistTransitionWhens: which transition() is the router's", () => {
  it("leaves a transition() that is not the router's untouched", async () => {
    expect(
      await hoist(`import { transition } from "./my-animation-lib";
const SECRET = "sk";
export async function ServerComp() {
  return transition({ when: (x) => x > SECRET });
}
`),
    ).toBeNull();
    expect(
      await hoist(`${R}import { transition } from "./my-animation-lib";
const SECRET = "sk";
export const cfg = transition({ when: (x) => x > SECRET });
`),
    ).toBeNull();
  });

  it("leaves a transition helper of a non-router urls() untouched", async () => {
    expect(
      await hoist(`import { urls } from "./my-urls";
import "@rangojs/router";
const SECRET = "sk";
urls(({ transition }) => [transition({ when: () => !!SECRET })]);
`),
    ).toBeNull();
  });

  it("leaves a transition that shadows the urls() helper untouched", async () => {
    expect(
      await hoist(`${R}const SECRET = "sk";
urls(({ path, transition }) => [
  path("/a", A, () => {
    const transition = (o) => o;
    return [transition({ when: () => !!SECRET })];
  }),
]);
`),
    ).toBeNull();
  });

  it("hoists an aliased router transition import", async () => {
    const result =
      await hoist(`import { urls, transition as t } from "@rangojs/router";
urls(({ path }) => [path("/a", A, () => [t({ when: () => true })])]);
`);
    expect(result!.code).toContain("t({ when: __rango_when_0 })");
    expect(result!.modules[0]).toContain(
      "export const __rango_when = () => true;",
    );
  });

  it("hoists a renamed urls() destructure and an aliased urls import", async () => {
    const renamed = await hoist(`${R}urls(({ path, transition: tx }) => [
  path("/a", A, () => [tx({ when: () => true })]),
]);
`);
    expect(renamed!.code).toContain("tx({ when: __rango_when_0 })");

    const aliased =
      await hoist(`import { urls as defineUrls } from "@rangojs/router";
defineUrls(function ({ path, transition }) {
  return [path("/a", A, () => [transition({ when: () => true })])];
});
`);
    expect(aliased!.code).toContain("transition({ when: __rango_when_0 })");
  });

  it("hoists through a namespace import and a helpers-object parameter", async () => {
    const result = await hoist(`import * as Rango from "@rangojs/router";
Rango.urls((h) => [
  h.path("/a", A, () => [h.transition({ when: () => true })]),
  h.path("/b", B, () => [Rango.transition({ when: () => false })]),
]);
`);
    expect(result!.code).toContain("h.transition({ when: __rango_when_0 })");
    expect(result!.code).toContain(
      "Rango.transition({ when: __rango_when_1 })",
    );
  });
});

describe("hoistTransitionWhens: module-loading expressions", () => {
  it("rejects a dynamic import(), naming it", async () => {
    const error = await hoistError(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => { import("./db-secrets.server.ts"); return true; } })]),
]);
`);
    expect(error.name).toBe("TransitionWhenError");
    expect(error.message).toContain('`import("./db-secrets.server.ts")`');
  });

  it("rejects import.meta other than import.meta.env, naming it", async () => {
    const glob = await hoistError(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => Object.keys(import.meta.glob("./server/*.ts")).length > 0 })]),
]);
`);
    expect(glob.name).toBe("TransitionWhenError");
    expect(glob.message).toContain("`import.meta.glob`");

    const bare = await hoistError(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => !!import.meta })]),
]);
`);
    expect(bare.message).toContain("`import.meta`");

    const env = await hoist(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => import.meta.env.DEV })]),
]);
`);
    expect(env!.modules[0]).toContain("import.meta.env.DEV");
  });
});

describe("hoistTransitionWhens: JSX references", () => {
  it("rejects a local component captured as JSX", async () => {
    const error = await hoistError(`${R}const SECRET = "sk";
const Local = () => SECRET;
urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => !!(<Local x={1} />) })]),
]);
`);
    expect(error.message).toContain("`Local` is a server-module binding");

    const member = await hoistError(`${R}const ui = { Badge: () => null };
urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => !!(<ui.Badge />) })]),
]);
`);
    expect(member.message).toContain("`ui` is a server-module binding");
  });

  it("checks a JSX import like any import, and ignores intrinsic tags", async () => {
    const error = await hoistError(
      `${R}import { ServerThing } from "./server-thing";
urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => !!(<ServerThing />) })]),
]);
`,
      { isServerOnlyImport: (source) => source === "./server-thing" },
    );
    expect(error.message).toContain(
      '`ServerThing` is imported from "./server-thing", a server-only module.',
    );

    const result = await hoist(`${R}import { Badge } from "./badge";
const div = 1;
urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: () => !!(<div><Badge.Icon /></div>) })]),
]);
`);
    expect(result!.modules[0]).toContain('import { Badge } from "./badge";');
    expect(result!.modules[0]).not.toContain("div =");
  });
});

describe("hoistTransitionWhens: this and arguments", () => {
  it("rejects `this` and `arguments` of the enclosing function in an arrow", async () => {
    const self = await hoistError(`${R}urls(function ({ path, transition }) {
  return [path("/a", A, () => [transition({ when: () => !!this })])];
});
`);
    expect(self.name).toBe("TransitionWhenError");
    expect(self.message).toContain("`this`");

    const args = await hoistError(`${R}urls(function ({ path, transition }) {
  return [path("/a", A, () => [transition({ when: () => arguments.length > 0 })])];
});
`);
    expect(args.message).toContain("`arguments`");
  });

  it("allows `this`/`arguments` of a function inside the literal or of a function literal", async () => {
    const result = await hoist(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [
    transition({
      when: () => {
        const f = function () { return this; };
        class K { v = this; m() { return arguments.length; } }
        return !!f.call(1) && (function () { return arguments.length; })() === 0 && !!K;
      },
    }),
  ]),
  path("/b", B, () => [transition({ when: function () { return !!this && arguments.length >= 0; } })]),
]);
`);
    expect(result!.modules).toHaveLength(2);
  });
});

describe("hoistTransitionWhens: key and wrapper shapes", () => {
  it("hoists a quoted `when` key", async () => {
    const result = await hoist(`${R}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ "when": () => true })]),
  path("/b", B, () => [transition({ 'when': () => false })]),
]);
`);
    expect(result!.code).toContain('transition({ "when": __rango_when_0 })');
    expect(result!.code).toContain("transition({ 'when': __rango_when_1 })");
  });

  it.each([
    ["as", "(() => true) as TransitionWhenFn"],
    ["satisfies", "(() => true) satisfies TransitionWhenFn"],
    ["parenthesized", "((() => true))"],
    ["non-null", "(() => true)!"],
    ["nested", "((() => true) as unknown as TransitionWhenFn)!"],
  ])(
    "unwraps a TS %s wrapper and hoists the inner function",
    async (_, expr) => {
      const result = await hoist(`${R}type TransitionWhenFn = () => boolean;
urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: ${expr} })]),
]);
`);
      expect(result).not.toBeNull();
      expect(result!.code).toContain("transition({ when: __rango_when_0 })");
      expect(result!.modules[0]).toContain(
        "export const __rango_when = () => true;",
      );
    },
  );

  it("unwraps a <T>expr type assertion in a .ts module", async () => {
    const file = "/app/src/urls.ts";
    const result = await hoist(
      `${R}type TransitionWhenFn = () => boolean;
urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: <TransitionWhenFn>(() => true) })]),
]);
`,
      undefined,
      file,
    );
    expect(result!.code).toContain("transition({ when: __rango_when_0 })");
    expect(result!.modules[0]).toContain(
      "export const __rango_when = () => true;",
    );
  });

  it("unwraps an identifier value before the local-binding check", async () => {
    const error = await hoistError(`${R}function holdWhen() { return true; }
urls(({ path, transition }) => [
  path("/p", Page, () => [transition({ when: holdWhen as any })]),
]);
`);
    expect(error.message).toContain("`holdWhen` is a server-module binding");
  });
});

describe("hoistTransitionWhens: capture analysis", () => {
  const site = (when: string, before = "") =>
    `${R}${before}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: ${when} })]),
]);
`;

  it("allows globals", async () => {
    const result = await hoist(
      site(
        "(ctx) => typeof window !== 'undefined' && Math.max(1, 2) > 0 && !!console && !!new URL(ctx.to.url)",
      ),
    );
    expect(result!.modules[0]).not.toContain("import ");
  });

  it("re-emits a namespace import used as ns.member, and leaves an ns.member value to discovery", async () => {
    const result = await hoist(
      site("() => Flags.enabled", 'import * as Flags from "./flags.js";\n'),
    );
    expect(result!.modules[0]).toContain(
      'import * as Flags from "./flags.js";',
    );

    expect(
      await hoist(
        site("Preds.holdWhen", 'import * as Preds from "./preds.js";\n'),
      ),
    ).toBeNull();

    await expect(
      hoist(
        site("() => !!fs.readFileSync", 'import * as fs from "node:fs";\n'),
      ),
    ).rejects.toThrow('`fs` is imported from "node:fs", a server-only module.');
  });

  it("rejects a capture in a default parameter value", async () => {
    const error = await hoistError(
      site("(ctx, n = SECRET) => !!n", 'const SECRET = "sk";\n'),
    );
    expect(error.message).toContain("`SECRET` is a server-module binding");
  });

  it("rejects object shorthand { SECRET } but not a key-only { SECRET: 1 }", async () => {
    const error = await hoistError(
      site("() => !!({ SECRET }).SECRET", 'const SECRET = "sk";\n'),
    );
    expect(error.message).toContain("`SECRET` is a server-module binding");

    const result = await hoist(
      site("() => !!({ SECRET: 1 }).SECRET", 'const SECRET = "sk";\n'),
    );
    expect(result!.modules).toHaveLength(1);
  });

  it("rejects a capture from a nested function, allows the literal's nested bindings", async () => {
    const error = await hoistError(
      site(
        "() => { function inner() { return SECRET; } return !!inner(); }",
        'const SECRET = "sk";\n',
      ),
    );
    expect(error.message).toContain("`SECRET` is a server-module binding");

    const result = await hoist(
      site(
        "() => { const k = 1; function inner() { return k; } class C { m() { return inner(); } } return !!C; }",
        'const k = "outer";\n',
      ),
    );
    expect(result!.modules).toHaveLength(1);
  });

  it("rejects block-scoped, var, catch-param and enum captures", async () => {
    const block = await hoistError(`${R}urls(({ path, transition }) => {
  if (Math.random() >= 0) {
    const x = 1;
    return [transition({ when: () => x > 0 })];
  }
  return [];
});
`);
    expect(block.message).toContain("`x` is a server-module binding");

    const hoistedVar = await hoistError(`${R}urls(({ path, transition }) => {
  const out = [transition({ when: () => !!v })];
  { var v = 1; }
  return out;
});
`);
    expect(hoistedVar.message).toContain("`v` is a server-module binding");

    const caught = await hoistError(`${R}urls(({ path, transition }) => {
  try { throw 1; } catch (e) { return [transition({ when: () => !!e })]; }
});
`);
    expect(caught.message).toContain("`e` is a server-module binding");

    const enumCapture = await hoistError(
      site("() => Mode.A === 0", "enum Mode { A, B }\n"),
    );
    expect(enumCapture.message).toContain("`Mode` is a server-module binding");
  });

  it("allows a local type, interface and typeof in type positions; the emitted module compiles without them", async () => {
    const result = await hoist(
      site(
        "(ctx: Local): ctx is Shape => { const v: typeof SECRET | undefined = undefined; return !v; }",
        "const SECRET = { a: 1 };\ntype Local = { n: number };\ninterface Shape extends Local { m: string }\n",
      ),
    );
    const module = result!.modules[0]!;
    expect(module).not.toContain("SECRET = ");
    const js = await compiled(module);
    expect(js).not.toMatch(/\bLocal\b|\bShape\b|\bSECRET\b/);
    expect(js).toContain("export const __rango_when");
  });
});

describe("hoisted when ids", () => {
  it("parses the file and index from a ?rango-when=N id", () => {
    expect(parseHoistedWhenId(`${FILE}?rango-when=2`)).toEqual({
      file: FILE,
      index: 2,
    });
    expect(parseHoistedWhenId(`${FILE}?rango-when=0&t=123`)).toEqual({
      file: FILE,
      index: 0,
    });
    expect(parseHoistedWhenId(FILE)).toBeNull();
    expect(parseHoistedWhenId(`${FILE}?rango-when=x`)).toBeNull();
  });

  it("classifies server-only specifiers", () => {
    expect(isServerOnlySpecifier("node:fs")).toBe(true);
    expect(isServerOnlySpecifier("fs")).toBe(true);
    expect(isServerOnlySpecifier("server-only")).toBe(true);
    expect(isServerOnlySpecifier("cloudflare:workers")).toBe(true);
    expect(isServerOnlySpecifier("./location-states.js")).toBe(false);
    expect(isServerOnlySpecifier("@rangojs/router")).toBe(false);
  });
});

type HookResult = { code: string } | string | undefined | null;
type HookFn = (this: unknown, ...args: string[]) => Promise<HookResult>;

describe("transitionWhenHoistPlugin", () => {
  let dir: string;
  const rsc = (resolveTo?: (source: string) => string) => ({
    environment: { name: "rsc" },
    resolve: async (source: string) =>
      resolveTo ? { id: resolveTo(source), external: false } : null,
  });
  const hooks = () => {
    const plugin = transitionWhenHoistPlugin();
    return {
      transform: plugin.transform as unknown as HookFn,
      load: plugin.load as unknown as HookFn,
    };
  };
  const urlsSource = (when: string, before = "") =>
    `${R}${before}urls(({ path, transition }) => [
  path("/a", A, () => [transition({ when: ${when} })]),
]);
`;

  beforeAll(async () => {
    dir = normalizePath(await mkdtemp(join(tmpdir(), "rango-when-hoist-")));
    await writeFile(
      join(dir, "db.ts"),
      'import "server-only";\nexport const db = {};\n',
    );
    await writeFile(join(dir, "flags.ts"), "export const enabled = true;\n");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("transforms only in the rsc environment, outside node_modules, and not hoisted ids", async () => {
    const { transform } = hooks();
    const code = urlsSource("() => true");
    const id = `${dir}/urls.tsx`;

    const out = (await transform.call(rsc(), code, id)) as { code: string };
    expect(out.code).toContain("transition({ when: __rango_when_0 })");

    expect(
      await transform.call({ environment: { name: "client" } }, code, id),
    ).toBeUndefined();
    expect(
      await transform.call({ environment: { name: "ssr" } }, code, id),
    ).toBeUndefined();
    expect(
      await transform.call(rsc(), code, "/app/node_modules/lib/urls.tsx"),
    ).toBeUndefined();
    expect(
      await transform.call(rsc(), code, `${id}?rango-when=0`),
    ).toBeUndefined();
  });

  it("resolves a re-emitted import and rejects it when the file imports server-only", async () => {
    const { transform } = hooks();
    const ctx = rsc((source) => join(dir, source.replace(/^\.\//, "")));
    const id = `${dir}/urls.tsx`;

    await expect(
      transform.call(
        ctx,
        urlsSource("() => !!db", 'import { db } from "./db.ts";\n'),
        id,
      ),
    ).rejects.toThrow('`db` is imported from "./db.ts", a server-only module.');

    const out = (await transform.call(
      ctx,
      urlsSource("() => enabled", 'import { enabled } from "./flags.ts";\n'),
      id,
    )) as { code: string };
    expect(out.code).toContain("__rango_when_0");
  });

  it("load serves module N of a file from disk, and throws for a missing index", async () => {
    const { load } = hooks();
    const file = `${dir}/cold.tsx`;
    await writeFile(file, urlsSource("() => 'cold'"));
    expect(await load.call({}, `${file}?rango-when=0`)).toContain(
      "export const __rango_when = () => 'cold';",
    );
    await expect(load.call({}, `${file}?rango-when=3`)).rejects.toThrow(
      `${file} has no inline transition({ when }) #3.`,
    );
    expect(await load.call({}, file)).toBeUndefined();
  });

  it("load serves the modules transform emitted when the pipeline code differs from disk", async () => {
    const { transform, load } = hooks();
    const file = `${dir}/pre-transformed.tsx`;
    await writeFile(file, urlsSource("() => 'disk'"));
    // An earlier plugin added a literal ahead of the one on disk.
    const pipeline = `${R}urls(({ path, transition }) => [
  path("/x", X, () => [transition({ when: () => 'prepended' })]),
  path("/a", A, () => [transition({ when: () => 'disk' })]),
]);
`;
    await transform.call(rsc(), pipeline, file);
    expect(await load.call({}, `${file}?rango-when=0`)).toContain(
      "export const __rango_when = () => 'prepended';",
    );
    expect(await load.call({}, `${file}?rango-when=1`)).toContain(
      "export const __rango_when = () => 'disk';",
    );
  });

  it("load re-hoists from disk once the file changed after the last transform", async () => {
    const { transform, load } = hooks();
    const file = `${dir}/edited.tsx`;
    await writeFile(file, urlsSource("() => 'before'"));
    await transform.call(rsc(), urlsSource("() => 'before'"), file);
    await writeFile(file, urlsSource("() => 'after'"));
    expect(await load.call({}, `${file}?rango-when=0`)).toContain(
      "export const __rango_when = () => 'after';",
    );
  });
});
