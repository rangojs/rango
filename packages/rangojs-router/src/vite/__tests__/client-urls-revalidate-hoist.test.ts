import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizePath, parseAst, transformWithOxc } from "vite";
import {
  createClientUrlRevalidateIndex,
  type ClientUrlRevalidateIndex,
} from "../discovery/state.js";
import { hasUseClientDirective } from "../utils/directive-prologue.js";
import {
  clientUrlsRevalidateHoistPlugin,
  hoistClientUrlsRevalidates,
  parseHoistedRevalidateId,
  revalidateKey,
} from "../plugins/client-urls-revalidate-hoist.js";

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();
  return { ...actual, parseAst: vi.fn(actual.parseAst) };
});
vi.mock("../utils/directive-prologue.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/directive-prologue.js")>();
  return {
    ...actual,
    hasUseClientDirective: vi.fn(actual.hasUseClientDirective),
  };
});

const ROOT = "/app";
const FILE = "/app/src/urls/shop.client.tsx";
const HEAD = `"use client";
import { clientUrls } from "@rangojs/router/client";
`;

/** A group whose one loader declares `revalidate(<predicate>)`. */
function group(predicate: string, imports = ""): string {
  return `${HEAD}${imports}export default clientUrls(({ path, loader, revalidate }) => [
  path("/cart", Cart, () => [
    loader(CartLoader, () => [revalidate(${predicate})]),
  ]),
]);
`;
}

async function hoist(
  code: string,
  deps: Partial<Parameters<typeof hoistClientUrlsRevalidates>[2]> = {},
  file: string = FILE,
) {
  return hoistClientUrlsRevalidates(code, file, { root: ROOT, ...deps });
}

async function hoistError(
  code: string,
  deps: Partial<Parameters<typeof hoistClientUrlsRevalidates>[2]> = {},
  file: string = FILE,
): Promise<Error> {
  try {
    await hoist(code, deps, file);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the hoist to throw");
}

const key = (source: string, file = "src/urls/shop.client.tsx"): string =>
  revalidateKey(file, source);

describe("hoistClientUrlsRevalidates", () => {
  it("replaces an inline predicate with a marker and registers it in a server module", async () => {
    const predicate =
      "(ctx) => ctx.isAction(ShopActions) ? ctx.actionResult?.ok === true : undefined";
    const result = await hoist(
      group(
        predicate,
        'import * as ShopActions from "./shop.actions";\nimport { Unused } from "./unused";\n',
      ),
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      `loader(CartLoader, () => [revalidate({ $$rangoRevalidate: "${key(predicate)}" })])`,
    );
    expect(result!.code).not.toContain("actionResult");
    // Imports stay in the "use client" module (not pruned in v1).
    expect(result!.code).toContain(
      'import * as ShopActions from "./shop.actions";',
    );
    expect(result!.keys).toEqual([key(predicate)]);
    expect(result!.module).toBe(
      [
        'import { registerClientUrlRevalidators as __rango_registerClientUrlRevalidators } from "@rangojs/router/server";',
        'import * as ShopActions from "./shop.actions";',
        "__rango_registerClientUrlRevalidators({",
        `  ${JSON.stringify(key(predicate))}: ${predicate},`,
        "});",
        "",
      ].join("\n"),
    );
  });

  it("hoists a function expression and keeps type-only imports as import type", async () => {
    const predicate =
      "function (ctx: RevalidateParams): boolean { return ctx.method === 'POST'; }";
    const result = await hoist(
      group(
        predicate,
        'import type { RevalidateParams } from "@rangojs/router";\n',
      ),
    );
    expect(result!.module).toContain(
      'import type { RevalidateParams } from "@rangojs/router";',
    );
    expect(result!.module).toContain(predicate);
    // The module compiles as the file's language, types erased.
    const js = (
      await transformWithOxc(result!.module, `${FILE}?rango-revalidate`, {
        jsx: "preserve",
      })
    ).code;
    expect(js).not.toContain("RevalidateParams");
  });

  it("drops TS wrappers from the hoisted source and replaces the whole argument", async () => {
    const result = await hoist(
      group(
        "((ctx) => ctx.stale) as ShouldRevalidateFn",
        'import type { ShouldRevalidateFn } from "@rangojs/router";\n',
      ),
    );
    expect(result!.code).toContain(
      `revalidate({ $$rangoRevalidate: "${key("(ctx) => ctx.stale")}" })`,
    );
    expect(result!.module).toContain(": (ctx) => ctx.stale,");
    // The wrapper's type reference went with it.
    expect(result!.module).not.toContain("ShouldRevalidateFn");
  });

  it("accepts an imported predicate, a namespace member and an imported factory call", async () => {
    const result =
      await hoist(`${HEAD}import { onCart, makeOnAction } from "./predicates";
import * as P from "./predicates";
export default clientUrls(({ path, loader, revalidate }) => [
  path("/cart", Cart, () => [
    loader(A, () => [revalidate(onCart)]),
    loader(B, () => [revalidate(P.cart)]),
    loader(C, () => [revalidate(makeOnAction("cart", Boolean))]),
  ]),
]);
`);
    expect(result!.keys).toEqual([
      key("onCart"),
      key("P.cart"),
      key('makeOnAction("cart", Boolean)'),
    ]);
    expect(result!.module).toContain(
      'import { onCart } from "./predicates";\nimport * as P from "./predicates";\nimport { makeOnAction } from "./predicates";',
    );
    expect(result!.module).toContain(
      `  ${JSON.stringify(key('makeOnAction("cart", Boolean)'))}: makeOnAction("cart", Boolean),`,
    );
  });

  it("gives identical predicates one key, and the same text in another file another key", async () => {
    const code = `${HEAD}export default clientUrls(({ path, loader, revalidate }) => [
  path("/a", A, () => [
    loader(A, () => [revalidate(() => false)]),
    loader(B, () => [revalidate(() => false)]),
  ]),
]);
`;
    const here = await hoist(code);
    expect(here!.keys).toEqual([key("() => false")]);
    expect(here!.module.match(/\(\) => false/g)).toHaveLength(1);
    expect(here!.code.match(/\$\$rangoRevalidate/g)).toHaveLength(2);

    const there = await hoist(code, {}, "/app/src/urls/other.client.tsx");
    expect(there!.keys).toEqual([
      key("() => false", "src/urls/other.client.tsx"),
    ]);
    expect(there!.keys[0]).not.toBe(here!.keys[0]);
  });

  it("keys a predicate by its syntax: formatting, comments, parentheses and types do not change it", async () => {
    const plain = key("(ctx) => ctx.nextParams.id === '1' && !ctx.stale");
    expect(
      key(`(
  ctx: RevalidateParams,
) => /* id */ (ctx.nextParams.id === "1") && !(ctx.stale as boolean)`),
    ).toBe(plain);
    expect(key("(ctx) => ctx.nextParams.id !== '1' && !ctx.stale")).not.toBe(
      plain,
    );
    expect(key("(ctx) => ctx.nextParams.id === '2' && !ctx.stale")).not.toBe(
      plain,
    );
    // The marker uses the same key as the module registers.
    const result = await hoist(
      group(`(
  ctx,
) => (ctx.nextParams.id === "1") && !ctx.stale`),
    );
    expect(result!.keys).toEqual([plain]);
  });

  it("keys a template's raw text: String.raw`\\x41` and String.raw`A` are different predicates", async () => {
    const escaped = "() => String.raw`\\x41` === 'A'";
    const plain = "() => String.raw`A` === 'A'";
    expect(key(escaped)).not.toBe(key(plain));
    // An untagged template and a quote style stay format-only.
    expect(key("() => `a${1}b`")).toBe(key("() => `a${1}b`"));
    expect(key("() => 'x' === \"x\"")).toBe(key("() => \"x\" === 'x'"));

    const result = await hoist(
      `${HEAD}export default clientUrls(({ path, loader, revalidate }) => [
  path("/a", A, () => [
    loader(A, () => [revalidate(${escaped})]),
    loader(B, () => [revalidate(${plain})]),
  ]),
]);
`,
    );
    expect(result!.keys).toEqual([key(escaped), key(plain)]);
    expect(result!.module).toContain(escaped);
    expect(result!.module).toContain(plain);
  });

  it("finds the helper however the builder callback binds it, at any depth", async () => {
    const result =
      await hoist(`${HEAD}export const a = clientUrls(({ layout, path, loader, revalidate: r }) => [
  layout(L, () => [
    loader(A, () => [r(() => 1 === 1)]),
    path("/p", P, { name: "p" }, () => [loader(B, () => [r(() => 2 === 2)])]),
  ]),
]);
export const b = clientUrls((h) => [
  h.path("/q", Q, () => [h.loader(C, () => [h.revalidate(() => 3 === 3)])]),
  h.intercept("@modal", ".q", M, () => [
    h.loader(D, () => [h.revalidate(() => 4 === 4)]),
  ]),
]);
`);
    expect(result!.keys).toEqual([
      key("() => 1 === 1"),
      key("() => 2 === 2"),
      key("() => 3 === 3"),
      key("() => 4 === 4"),
    ]);
  });

  it("recognizes clientUrls renamed or through a namespace import", async () => {
    const renamed = await hoist(`"use client";
import { clientUrls as cu } from "@rangojs/router/client";
export default cu(({ path, loader, revalidate }) => [
  path("/", P, () => [loader(A, () => [revalidate(() => true)])]),
]);
`);
    expect(renamed!.keys).toEqual([key("() => true")]);

    const namespace = await hoist(`"use client";
import * as Rango from "@rangojs/router/client";
export default Rango.clientUrls(({ path, loader, revalidate }) => [
  path("/", P, () => [loader(A, () => [revalidate(() => true)])]),
]);
`);
    expect(namespace!.keys).toEqual([key("() => true")]);
  });

  describe("a component's .use: revalidate imported from @rangojs/router/client", () => {
    const COMPONENT = "/app/src/dash/Dashboard.tsx";
    const componentKey = (source: string) =>
      revalidateKey("src/dash/Dashboard.tsx", source);
    /** A page component module whose `.use` declares `revalidate(<arg>)`. */
    const component = (arg: string, head = '"use client";\n') =>
      `${head}import { loader, loading, revalidate } from "@rangojs/router/client";
import * as StatsActions from "./stats.actions";
import { StatsLoader } from "./stats.loader";
export function Dashboard() {
  return null;
}
Dashboard.use = () => [
  loader(StatsLoader, () => [revalidate(${arg})]),
  loading(null),
];
`;

    it("hoists the predicate of a component module, with or without use client", async () => {
      const predicate = "({ isAction }) => isAction(StatsActions)";
      for (const head of ['"use client";\n', ""]) {
        const result = await hoist(component(predicate, head), {}, COMPONENT);
        expect(result!.keys).toEqual([componentKey(predicate)]);
        expect(result!.code).toContain(
          `loader(StatsLoader, () => [revalidate({ $$rangoRevalidate: "${componentKey(predicate)}" })])`,
        );
        expect(result!.module).toBe(
          [
            'import { registerClientUrlRevalidators as __rango_registerClientUrlRevalidators } from "@rangojs/router/server";',
            'import * as StatsActions from "./stats.actions";',
            "__rango_registerClientUrlRevalidators({",
            `  ${JSON.stringify(componentKey(predicate))}: ${predicate},`,
            "});",
            "",
          ].join("\n"),
        );
      }
    });

    it("finds the helper renamed or through a namespace import, and leaves a boolean literal in place", async () => {
      const result = await hoist(
        `import { revalidate as r } from "@rangojs/router/client";
import * as Rango from "@rangojs/router/client";
export const items = () => [
  Rango.loader(A, () => [r(() => 1 === 1), r(false)]),
  Rango.loader(B, () => [Rango.revalidate(() => 2 === 2), Rango.revalidate(true)]),
];
`,
        {},
        COMPONENT,
      );
      expect(result!.keys).toEqual([
        componentKey("() => 1 === 1"),
        componentKey("() => 2 === 2"),
      ]);
      expect(result!.code).toContain("r(false)");
      expect(result!.code).toContain("Rango.revalidate(true)");
      expect(await hoist(component("true"), {}, COMPONENT)).toBeNull();
    });

    it("leaves alone a revalidate from another module or a shadowing local", async () => {
      expect(
        await hoist(
          `import "@rangojs/router/client";
import { revalidate } from "./elsewhere";
export const x = revalidate(() => true);
`,
          {},
          COMPONENT,
        ),
      ).toBeNull();
      expect(
        await hoist(
          `import { loader } from "@rangojs/router/client";
export const items = (revalidate) => [loader(A, () => [revalidate(() => true)])];
`,
          {},
          COMPONENT,
        ),
      ).toBeNull();
    });

    it("rejects an impure predicate, naming the component module's file:line", async () => {
      const local = await hoistError(
        component("() => LIMIT > 1").replace(
          "export function Dashboard",
          "const LIMIT = 3;\nexport function Dashboard",
        ),
        {},
        COMPONENT,
      );
      expect(local.message).toMatch(
        /^\[rango\] clientUrls\(\) revalidate\(\) at \/app\/src\/dash\/Dashboard\.tsx:\d+:/,
      );
      expect(local.message).toContain(
        '`LIMIT` is declared in this "use client" module.',
      );
      const plain = await hoistError(
        component("() => LIMIT > 1", "").replace(
          "export function Dashboard",
          "const LIMIT = 3;\nexport function Dashboard",
        ),
        {},
        COMPONENT,
      );
      expect(plain.message).toContain(
        '`LIMIT` is declared in this module. Move the predicate to its own module (without "use client")',
      );
      expect(
        (await hoistError(component("() => !!window"), {}, COMPONENT)).message,
      ).toContain("`window` is a browser global");
      const clientImport = await hoistError(
        component("() => useThing()").replace(
          "import { StatsLoader }",
          'import { useThing } from "./hooks";\nimport { StatsLoader }',
        ),
        { isClientModule: (source) => source === "./hooks" },
        COMPONENT,
      );
      expect(clientImport.message).toContain(
        '`useThing` is imported from "./hooks", a client-only module',
      );
    });
  });

  it("leaves a module alone without the router's clientUrls or revalidate", async () => {
    expect(
      await hoist(`"use client";
import { clientUrls } from "./my-dsl";
import "@rangojs/router/client";
export default clientUrls(({ path, loader, revalidate }) => [
  path("/", P, () => [loader(A, () => [revalidate(() => true)])]),
]);
`),
    ).toBeNull();
    expect(
      await hoist(`${HEAD}import { revalidate } from "./elsewhere";
export const x = revalidate(() => true);
export default clientUrls(({ path }) => [path("/", P)]);
`),
    ).toBeNull();
    // A shadowing local named like the helper is not the helper.
    expect(
      await hoist(`${HEAD}export default clientUrls(({ path, loader }) => {
  const revalidate = (fn) => fn;
  return [path("/", P, () => [loader(A, () => [revalidate(() => true)])])];
});
`),
    ).toBeNull();
  });

  it("leaves a boolean literal in place and hoists the predicates beside it", async () => {
    const predicate = "({ stale }) => stale === true";
    const result =
      await hoist(`${HEAD}export default clientUrls(({ path, loader, revalidate }) => [
  path("/cart", Cart, () => [
    loader(A, () => [revalidate(true)]),
    loader(B, () => [revalidate(false as const)]),
    loader(C, () => [revalidate((false)), revalidate(${predicate})]),
  ]),
]);
`);
    expect(result!.code).toContain("loader(A, () => [revalidate(true)])");
    expect(result!.code).toContain(
      "loader(B, () => [revalidate(false as const)])",
    );
    expect(result!.code).toContain(
      `revalidate((false)), revalidate({ $$rangoRevalidate: "${key(predicate)}" })`,
    );
    expect(result!.keys).toEqual([key(predicate)]);
    expect(result!.module).toBe(
      [
        'import { registerClientUrlRevalidators as __rango_registerClientUrlRevalidators } from "@rangojs/router/server";',
        "__rango_registerClientUrlRevalidators({",
        `  ${JSON.stringify(key(predicate))}: ${predicate},`,
        "});",
        "",
      ].join("\n"),
    );
  });

  it("leaves a module alone whose every revalidate() is a boolean literal", async () => {
    expect(await hoist(group("true"))).toBeNull();
    expect(await hoist(group("false"))).toBeNull();
  });

  it("hoists a non-literal argument whatever it evaluates to: the server evaluates it", async () => {
    // An imported boolean and an imported predicate are both identifiers to
    // the build; materialization accepts a boolean value and rejects others.
    const result = await hoist(
      `${HEAD}import { HOLD } from "./flags";
export default clientUrls(({ path, loader, revalidate }) => [
  path("/cart", Cart, () => [
    loader(A, () => [revalidate(HOLD)]),
    loader(B, () => [revalidate(!import.meta.env.DEV)]),
    loader(C, () => [revalidate(HOLD ? true : false), revalidate(!HOLD)]),
  ]),
]);
`,
    );
    expect(result!.keys).toEqual([
      key("HOLD"),
      key("!import.meta.env.DEV"),
      key("HOLD ? true : false"),
      key("!HOLD"),
    ]);
    expect(result!.module).toContain('import { HOLD } from "./flags";');
    expect(result!.module).toContain(`  ${JSON.stringify(key("HOLD"))}: HOLD,`);
    expect(result!.code).toContain(
      `revalidate({ $$rangoRevalidate: "${key("!import.meta.env.DEV")}" })`,
    );
  });

  it("rejects a boolean bound in the use client module, naming file:line", async () => {
    const error = await hoistError(`${HEAD}const HOLD = false;
export default clientUrls(({ path, loader, revalidate }) => [
  path("/cart", Cart, () => [loader(A, () => [revalidate(HOLD)])]),
]);
`);
    expect(error.message).toMatch(
      /^\[rango\] clientUrls\(\) revalidate\(\) at \/app\/src\/urls\/shop\.client\.tsx:5:/,
    );
    expect(error.message).toContain(
      '`HOLD` is declared in this "use client" module.',
    );
  });

  it("allows globals, import.meta.env, and a use server, node: or server-only import", async () => {
    const result = await hoist(
      group(
        "({ nextUrl, actionId }) => new URL(nextUrl).search !== '' && import.meta.env.DEV && isAction(actionId) && existsSync('/x') && guard()",
        'import { isAction } from "./cart.actions";\nimport { existsSync } from "node:fs";\nimport { guard } from "server-only";\n',
      ),
      { isClientModule: () => false },
    );
    expect(result!.module).toContain('import { existsSync } from "node:fs";');
  });

  describe("rejects a predicate that is not pure, naming file:line", () => {
    it("a binding declared in the use client module", async () => {
      const error =
        await hoistError(`${HEAD}function productData({ isAction }) {
  return !isAction();
}
export default clientUrls(({ path, loader, revalidate }) => [
  path("/p/:slug", P, () => [loader(A, () => [revalidate(productData)])]),
]);
`);
      expect(error.message).toContain(`${FILE}:7:`);
      expect(error.message).toContain("revalidate() runs on the server");
      expect(error.message).toContain(
        '`productData` is declared in this "use client" module. Move the predicate to its own module (without "use client") and import it',
      );

      const local = await hoistError(
        `${HEAD}const LIMIT = 3;\n${group("() => LIMIT > 1").slice(HEAD.length)}`,
      );
      expect(local.message).toContain("`LIMIT` is declared in this");
    });

    it("a binding of an enclosing function", async () => {
      const error =
        await hoistError(`${HEAD}export default clientUrls(({ path, loader, revalidate }) => {
  const hold = true;
  return [path("/", P, () => [loader(A, () => [revalidate(() => !hold)])])];
});
`);
      expect(error.message).toContain(
        "`hold` is a binding of the enclosing function",
      );
    });

    it("this, arguments, import() and import.meta other than env", async () => {
      expect((await hoistError(group("() => this.flag"))).message).toContain(
        "`this`",
      );
      expect(
        (
          await hoistError(`${HEAD}export default clientUrls(function ({ path, loader, revalidate }) {
  return [path("/", P, () => [loader(A, () => [revalidate(() => arguments.length > 0)])])];
});
`)
        ).message,
      ).toContain("`arguments`");
      expect(
        (await hoistError(group("() => !!import('./x')"))).message,
      ).toContain("`import('./x')` loads a module at run time");
      expect(
        (await hoistError(group("() => import.meta.url !== ''"))).message,
      ).toContain("`import.meta.url`");
    });

    it("a browser-only global", async () => {
      for (const name of ["window", "document", "localStorage"]) {
        const error = await hoistError(group(`() => !!${name}`));
        expect(error.message).toContain(`\`${name}\` is a browser global`);
      }
    });

    it("an async or generator function", async () => {
      expect((await hoistError(group("async () => true"))).message).toContain(
        "an `async` function returns a Promise",
      );
      expect(
        (await hoistError(group("function* () { yield true; }"))).message,
      ).toContain("a generator function returns an iterator");
    });

    it("a spread, a second argument, no argument, or a value that is neither a function nor a boolean", async () => {
      for (const args of ["...fns", "() => true, extra", "", "true, false"]) {
        expect((await hoistError(group(args))).message).toContain(
          "`revalidate()` takes exactly one predicate or boolean.",
        );
      }
      for (const value of ["{ ok: true }", "'yes'", "[]", "0", "null", "`x`"]) {
        expect((await hoistError(group(value))).message).toContain(
          "`revalidate()` expects a predicate function or a boolean.",
        );
      }
    });

    it("an import of client-only or of a use client module", async () => {
      expect(
        (
          await hoistError(
            group("() => flag", 'import { flag } from "client-only";\n'),
          )
        ).message,
      ).toContain(
        '`flag` is imported from "client-only", a client-only module',
      );
      const error = await hoistError(
        group("() => useThing()", 'import { useThing } from "./hooks";\n'),
        { isClientModule: (source) => source === "./hooks" },
      );
      expect(error.message).toContain(
        '`useThing` is imported from "./hooks", a client-only module',
      );
      // A type-only use is never checked.
      expect(
        await hoist(
          group(
            "(ctx: Ctx) => ctx.stale",
            'import type { Ctx } from "./hooks";\n',
          ),
          { isClientModule: () => true },
        ),
      ).not.toBeNull();
    });
  });

  describe("pre-filter", () => {
    beforeEach(() => {
      vi.mocked(parseAst).mockClear();
    });

    it("does not parse a module that never names revalidate", async () => {
      const code = `"use client";
import { clientUrls, useNavigation } from "@rangojs/router/client";
export default clientUrls(({ path }) => [path("/", () => useNavigation())]);
`;
      expect(await hoist(code)).toBeNull();
      expect(parseAst).not.toHaveBeenCalled();
    });

    it("does not parse a module that never imports @rangojs/router/client", async () => {
      const code = group("() => true").replace(
        '"@rangojs/router/client"',
        '"./my-dsl"',
      );
      expect(await hoist(code)).toBeNull();
      expect(parseAst).not.toHaveBeenCalled();
    });

    it("parses a candidate and hoists it", async () => {
      expect(await hoist(group("() => true"))).not.toBeNull();
      expect(parseAst).toHaveBeenCalledTimes(1);
    });
  });

  describe("imports checked concurrently", () => {
    const code = group(
      "() => a && b",
      'import { a } from "./one";\nimport { b } from "./two";\n',
    );

    it("starts every import's check before any settles", async () => {
      let inFlight = 0;
      let peak = 0;
      await hoist(code, {
        isClientModule: async () => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return false;
        },
      });
      expect(peak).toBe(2);
    });

    it("reports the first offending import in source order", async () => {
      const slowFirst = await hoistError(code, {
        isClientModule: async (source) => {
          await new Promise((resolve) =>
            setTimeout(resolve, source === "./one" ? 10 : 0),
          );
          return true;
        },
      });
      expect(slowFirst.message).toContain('`a` is imported from "./one"');
    });
  });

  it("parses a ?rango-revalidate id", () => {
    expect(parseHoistedRevalidateId(`${FILE}?rango-revalidate`)).toBe(FILE);
    expect(parseHoistedRevalidateId(`${FILE}?v=1&rango-revalidate`)).toBe(FILE);
    expect(parseHoistedRevalidateId(FILE)).toBeNull();
    expect(parseHoistedRevalidateId(`${FILE}?rango-when=0`)).toBeNull();
  });
});

describe("clientUrlsRevalidateHoistPlugin", () => {
  let dir: string;
  type Hook = (this: unknown, ...args: any[]) => any;
  interface IdFilter {
    include?: RegExp;
    exclude?: RegExp[];
  }
  interface ObjectHook {
    filter: { id?: RegExp | IdFilter; code?: RegExp | string };
    handler: Hook;
  }
  function hooks(
    root: string,
    index: ClientUrlRevalidateIndex = createClientUrlRevalidateIndex(),
  ) {
    const [pre, post] = clientUrlsRevalidateHoistPlugin(index);
    (pre!.configResolved as Hook).call({}, { root });
    const loadHook = pre!.load as unknown as ObjectHook;
    return {
      post: post!,
      transformHook: pre!.transform as unknown as ObjectHook,
      loadHook,
      registerHook: post!.transform as unknown as ObjectHook,
      transform: (pre!.transform as unknown as ObjectHook).handler,
      /** The code `load` serves, or undefined for an id it does not serve. */
      async load(this: unknown, id: string): Promise<string | undefined> {
        const out = (await loadHook.handler.call(this, id)) as
          | { code: string }
          | undefined;
        return out?.code;
      },
      register: (post!.transform as unknown as ObjectHook).handler,
      buildStart: pre!.buildStart as Hook,
      watchChange: pre!.watchChange as Hook,
    };
  }
  /** What Vite's hook filter accepts: include (if any) and no exclude. */
  function accepts(
    filter: ObjectHook["filter"],
    id: string,
    code: string,
  ): boolean {
    const idFilter =
      filter.id instanceof RegExp ? { include: filter.id } : filter.id;
    if (idFilter?.exclude?.some((re) => re.test(id))) return false;
    if (idFilter?.include && !idFilter.include.test(id)) return false;
    const { code: codeFilter } = filter;
    if (typeof codeFilter === "string") return code.includes(codeFilter);
    return codeFilter ? codeFilter.test(code) : true;
  }
  const env = (name: string, resolve?: (source: string) => string) => ({
    environment: { name },
    resolve: async (source: string) =>
      resolve ? { id: resolve(source), external: false } : null,
  });

  beforeAll(async () => {
    dir = normalizePath(
      await mkdtemp(join(tmpdir(), "rango-revalidate-hoist-")),
    );
    await writeFile(
      join(dir, "hooks.ts"),
      '"use client";\nexport const useThing = () => true;\n',
    );
    await writeFile(
      join(dir, "cart.actions.ts"),
      '"use server";\nexport async function checkout() {}\n',
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts markers in every environment, outside node_modules and hoisted ids", async () => {
    const { transform } = hooks(dir);
    const code = group("() => true");
    const id = `${dir}/shop.client.tsx`;
    for (const name of ["client", "ssr", "rsc"]) {
      const out = (await transform.call(env(name), code, id)) as {
        code: string;
      };
      expect(out.code).toContain(
        `revalidate({ $$rangoRevalidate: "${revalidateKey("shop.client.tsx", "() => true")}" })`,
      );
    }
    expect(
      await transform.call(env("rsc"), code, "/app/node_modules/lib/x.tsx"),
    ).toBeUndefined();
    expect(
      await transform.call(env("rsc"), code, `${id}?rango-revalidate`),
    ).toBeUndefined();
  });

  it("appends the import of its ?rango-revalidate module to the RSC proxy of every group, with or without predicates, and of no other module", async () => {
    const { transform, register } = hooks(dir);
    const proxy =
      'import * as $$ReactServer from "x";\nexport default $$ReactServer.registerClientReference(() => {}, "/proxy.client.tsx", "default");\n';
    const appended = (id: string) =>
      `${proxy}\nimport ${JSON.stringify(`${id}?rango-revalidate`)};\n`;

    const id = `${dir}/proxy.client.tsx`;
    await transform.call(env("rsc"), group("() => true"), id);
    expect(await register.call(env("rsc"), proxy, id)).toEqual(
      expect.objectContaining({ code: appended(id) }),
    );

    // Its predicates may sit in a component module it imports.
    const plain = `${dir}/plain.client.tsx`;
    await transform.call(
      env("rsc"),
      `${HEAD}export default clientUrls(({ path }) => [path("/", P)]);\n`,
      plain,
    );
    expect(await register.call(env("rsc"), proxy, plain)).toEqual(
      expect.objectContaining({ code: appended(plain) }),
    );

    // A component module with predicates is reached through its groups.
    const component = `${dir}/Component.tsx`;
    await transform.call(
      env("rsc"),
      `"use client";
import { loader, revalidate } from "@rangojs/router/client";
export function Component() { return null; }
Component.use = () => [loader(A, () => [revalidate(() => true)])];
`,
      component,
    );
    expect(await register.call(env("rsc"), proxy, component)).toBeUndefined();

    // A module that stops being a group loses the import.
    await transform.call(
      env("rsc"),
      '"use client";\nexport const clientUrls = 1;\n',
      plain,
    );
    expect(await register.call(env("rsc"), proxy, plain)).toBeUndefined();
  });

  it("leaves a module of boolean literals as is", async () => {
    const { transform, load } = hooks(dir);
    const id = `${dir}/literal.client.tsx`;
    for (const name of ["client", "ssr", "rsc"]) {
      expect(
        await transform.call(env(name), group("false"), id),
      ).toBeUndefined();
    }
    await writeFile(id, group("false"));
    expect(await load.call(env("rsc"), `${id}?rango-revalidate`)).toBe(
      "export {};\n",
    );
  });

  it("registers its post transform in the rsc environment only", () => {
    const { post, registerHook } = hooks(dir);
    const applies = post.applyToEnvironment as unknown as (env: {
      name: string;
    }) => boolean;
    expect(applies({ name: "rsc" })).toBe(true);
    expect(applies({ name: "ssr" })).toBe(false);
    expect(applies({ name: "client" })).toBe(false);
    expect(registerHook.filter.code).toBe("registerClientReference");
  });

  it("drops the emitted entry of a changed file", async () => {
    const { transform, register, watchChange } = hooks(dir);
    const id = `${dir}/changed.client.tsx`;
    const proxy =
      'import * as $$ReactServer from "x";\nexport default $$ReactServer.registerClientReference(() => {}, "/changed.client.tsx", "default");\n';
    await transform.call(env("rsc"), group("() => true"), id);
    expect(await register.call(env("rsc"), proxy, id)).toBeDefined();
    await watchChange.call({}, id, { event: "update" });
    expect(await register.call(env("rsc"), proxy, id)).toBeUndefined();
  });

  describe("hook filters", () => {
    it("accept every id and code the handlers would hoist or serve", async () => {
      const { transform, transformHook, loadHook } = hooks(dir);
      const code = group("() => true");
      const ids = [
        `${dir}/a.client.tsx`,
        `${dir}/a.client.ts`,
        `${dir}/a.client.jsx`,
        `${dir}/a.client.mjs`,
        `${dir}/a.client.tsx?v=123`,
        `${dir}/a.client.tsx?t=1&import`,
        `${dir}/a.client.css`,
        `${dir}/a.client.tsx.map`,
        `${dir}/a.client.tsx?rango-revalidate`,
        `${dir}/a.client.tsx?v=1&rango-revalidate`,
        "/app/node_modules/lib/a.client.tsx",
      ];
      for (const id of ids) {
        const out = await transform.call(env("rsc"), code, id);
        if (out !== undefined) {
          expect(accepts(transformHook.filter, id, code), id).toBe(true);
        }
      }
      expect(accepts(transformHook.filter, ids[0]!, code)).toBe(true);
      expect(accepts(transformHook.filter, ids[4]!, code)).toBe(true);
      expect(accepts(transformHook.filter, ids[6]!, code)).toBe(false);
      expect(accepts(transformHook.filter, ids[8]!, code)).toBe(false);
      expect(accepts(transformHook.filter, ids[10]!, code)).toBe(false);
      expect(
        accepts(
          transformHook.filter,
          ids[0]!,
          'export const x = "use client";',
        ),
      ).toBe(false);

      expect(accepts(loadHook.filter, ids[8]!, "")).toBe(true);
      expect(accepts(loadHook.filter, ids[9]!, "")).toBe(true);
      expect(accepts(loadHook.filter, ids[0]!, "")).toBe(false);
      expect(
        accepts(loadHook.filter, `${dir}/a.tsx?rango-revalidated`, ""),
      ).toBe(false);
    });
  });

  it("rejects in the RSC environment an import that resolves to a use client module", async () => {
    const { transform } = hooks(dir);
    const resolve = (source: string) =>
      join(dir, `${source.replace(/^\.\//, "")}.ts`);
    await expect(
      transform.call(
        env("rsc", resolve),
        group("() => useThing()", 'import { useThing } from "./hooks";\n'),
        `${dir}/bad.client.tsx`,
      ),
    ).rejects.toThrow('`useThing` is imported from "./hooks"');
    const out = (await transform.call(
      env("rsc", resolve),
      group(
        "({ isAction }) => isAction(checkout)",
        'import { checkout } from "./cart.actions";\n',
      ),
      `${dir}/good.client.tsx`,
    )) as { code: string };
    expect(out.code).toContain("$$rangoRevalidate");
  });

  describe("isClientModule", () => {
    const resolveTo = (source: string) =>
      join(dir, `${source.replace(/^\.\//, "")}.ts`);
    const imports = 'import { flag } from "./memo-dep";\n';
    const usesFlag = group("() => flag", imports);
    const dep = () => join(dir, "memo-dep.ts");

    beforeEach(() => {
      vi.mocked(hasUseClientDirective).mockClear();
    });

    // The group's own code is checked too (isGroupModule).
    const depChecks = () =>
      vi
        .mocked(hasUseClientDirective)
        .mock.calls.filter(([text]) => !text.includes("clientUrls")).length;

    it("parses only a dependency that contains the directive text", async () => {
      const { transform } = hooks(dir);
      await writeFile(dep(), "export const flag = true;\n");
      await transform.call(
        env("rsc", resolveTo),
        usesFlag,
        `${dir}/guard.client.tsx`,
      );
      expect(depChecks()).toBe(0);

      await writeFile(
        join(dir, "memo-dep.ts"),
        '// "use client" in a comment only\nexport const flag = true;\n',
      );
      const { transform: fresh } = hooks(dir);
      await fresh.call(
        env("rsc", resolveTo),
        usesFlag,
        `${dir}/guard.client.tsx`,
      );
      expect(depChecks()).toBe(1);
    });

    it("remembers a dependency until buildStart or a change to it", async () => {
      const { transform, buildStart, watchChange } = hooks(dir);
      const run = () =>
        transform.call(
          env("rsc", resolveTo),
          usesFlag,
          `${dir}/memo.client.tsx`,
        );
      await writeFile(dep(), "export const flag = true;\n");
      expect(await run()).toBeDefined();

      await writeFile(dep(), '"use client";\nexport const flag = true;\n');
      expect(await run()).toBeDefined();

      await buildStart.call({});
      await expect(run()).rejects.toThrow(
        '`flag` is imported from "./memo-dep"',
      );

      await writeFile(dep(), "export const flag = true;\n");
      await expect(run()).rejects.toThrow(
        '`flag` is imported from "./memo-dep"',
      );
      await watchChange.call({}, dep(), { event: "update" });
      expect(await run()).toBeDefined();
    });
  });

  describe("a group's ?rango-revalidate module: its registrations and those of the files discovery assigned it", () => {
    let app: string;
    const files: Record<string, string> = {
      // A group without a predicate of its own.
      "app.urls.tsx": `"use client";
import { clientUrls } from "@rangojs/router/client";
import { Dashboard } from "./dash";
export default clientUrls(({ path }) => [path("/dash", Dashboard)]);
`,
      // A group with one.
      "own.urls.tsx": group("() => true"),
      "dash/index.ts": 'export * from "./Dashboard";\n',
      "dash/Dashboard.tsx": `import { loader, loading, revalidate } from "@rangojs/router/client";
import * as StatsActions from "./stats.actions";
import { StatsLoader } from "./stats.loader";
export function Dashboard() {
  return null;
}
Dashboard.use = () => [
  loader(StatsLoader, () => [revalidate(({ isAction }) => isAction(StatsActions)), revalidate(false)]),
  loading(null),
];
`,
      "dash/stats.actions.ts":
        '"use server";\nexport async function bump() {}\n',
      "dash/stats.loader.ts":
        'import { createLoader } from "@rangojs/router";\nexport const StatsLoader = createLoader(async () => 1);\n',
      "Shell.tsx": '"use client";\nexport function Shell() { return null; }\n',
    };
    const predicate = "({ isAction }) => isAction(StatsActions)";

    beforeAll(async () => {
      app = normalizePath(join(dir, "app"));
      for (const [name, text] of Object.entries(files)) {
        await mkdir(dirname(join(app, name)), { recursive: true });
        await writeFile(join(app, name), text);
      }
    });

    /** Resolve like Vite: relative to the importer, extension and index lookup. */
    const rsc = {
      environment: { name: "rsc" },
      async resolve(source: string, importer?: string) {
        if (source.startsWith("@rangojs/")) {
          return { id: "/repo/packages/rangojs-router/src/client.rsc.tsx" };
        }
        const base = normalizePath(join(dirname(importer!), source));
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
          if (
            candidate.startsWith(`${app}/`) &&
            files[candidate.slice(app.length + 1)] !== undefined
          ) {
            return { id: candidate };
          }
        }
        return null;
      },
    };
    const imported = (name: string) =>
      `import ${JSON.stringify(`${app}/${name}?rango-revalidate`)};\n`;

    it("the component's module registers its predicate under the key its client and SSR copies carry, which record its file", async () => {
      const index = createClientUrlRevalidateIndex();
      const { load, transform } = hooks(app, index);
      const file = `${app}/dash/Dashboard.tsx`;
      const key = revalidateKey("dash/Dashboard.tsx", predicate);
      expect(await load.call(rsc, `${file}?rango-revalidate`)).toBe(
        [
          'import { registerClientUrlRevalidators as __rango_registerClientUrlRevalidators } from "@rangojs/router/server";',
          'import * as StatsActions from "./stats.actions";',
          "__rango_registerClientUrlRevalidators({",
          `  ${JSON.stringify(key)}: ${predicate},`,
          "});",
          "",
        ].join("\n"),
      );
      for (const name of ["client", "ssr"]) {
        index.fileByKey.clear();
        const marked = (await transform.call(
          { environment: { name } },
          files["dash/Dashboard.tsx"],
          file,
        )) as { code: string };
        expect(marked.code).toContain(
          `revalidate({ $$rangoRevalidate: "${key}" }), revalidate(false)`,
        );
        expect(index.fileByKey).toEqual(new Map([[key, file]]));
      }
    });

    it("a group's module imports the registrations of each file discovery assigned it, after its own", async () => {
      const index = createClientUrlRevalidateIndex();
      const { load } = hooks(app, index);
      const plain = `${app}/app.urls.tsx`;
      const dashboard = `${app}/dash/Dashboard.tsx`;
      expect(await load.call(rsc, `${plain}?rango-revalidate`)).toBe(
        "export {};\n",
      );
      index.filesByGroup.set(plain, [dashboard]);
      expect(await load.call(rsc, `${plain}?rango-revalidate`)).toBe(
        imported("dash/Dashboard.tsx"),
      );

      const own = `${app}/own.urls.tsx`;
      index.filesByGroup.set(own, [dashboard]);
      const out = (await load.call(rsc, `${own}?rango-revalidate`)) as string;
      expect(out).toContain(
        `  ${JSON.stringify(revalidateKey("own.urls.tsx", "() => true"))}: () => true,\n});\n`,
      );
      expect(out.endsWith(`});\n${imported("dash/Dashboard.tsx")}`)).toBe(true);
    });

    it("every module it serves keeps its side effects, whatever the app's sideEffects field says: the build reaches it only through bare imports", async () => {
      const index = createClientUrlRevalidateIndex();
      const { loadHook } = hooks(app, index);
      index.filesByGroup.set(`${app}/app.urls.tsx`, [
        `${app}/dash/Dashboard.tsx`,
      ]);
      // Registrations, a group's imports of its assigned files, nothing.
      for (const name of ["dash/Dashboard.tsx", "app.urls.tsx", "Shell.tsx"]) {
        expect(
          await loadHook.handler.call(rsc, `${app}/${name}?rango-revalidate`),
          name,
        ).toEqual({
          code: expect.any(String),
          moduleSideEffects: "no-treeshake",
        });
      }
    });

    it("a module no group was assigned serves its own registrations, not those of its imports", async () => {
      const { load } = hooks(app);
      for (const name of [
        "dash/index.ts",
        "dash/stats.actions.ts",
        "dash/stats.loader.ts",
        "Shell.tsx",
      ]) {
        expect(await load.call(rsc, `${app}/${name}?rango-revalidate`)).toBe(
          "export {};\n",
        );
      }
    });

    it('rejects, when the module loads, a predicate importing a "use client" module', async () => {
      const { load } = hooks(app);
      const file = `${app}/dash/Bad.tsx`;
      files["dash/Bad.tsx"] = "";
      await writeFile(
        file,
        `import { loader, revalidate } from "@rangojs/router/client";
import { Shell } from "../Shell";
export function Bad() { return null; }
Bad.use = () => [loader(A, () => [revalidate(() => Shell.length > 0)])];
`,
      );
      await expect(load.call(rsc, `${file}?rango-revalidate`)).rejects.toThrow(
        '`Shell` is imported from "../Shell"',
      );
    });
  });

  it("load serves the RSC transform's module, re-hoists an edited file from disk, and an empty module without predicates", async () => {
    const { transform, load } = hooks(dir);
    const file = `${dir}/served.client.tsx`;
    await writeFile(file, group("() => 'disk'"));
    // An earlier plugin changed the pipeline text: the transform's module wins.
    await transform.call(env("rsc"), group("() => 'pipeline'"), file);
    expect(await load.call(env("rsc"), `${file}?rango-revalidate`)).toContain(
      "() => 'pipeline'",
    );

    await writeFile(file, group("() => 'edited'"));
    expect(await load.call(env("rsc"), `${file}?rango-revalidate`)).toContain(
      "() => 'edited'",
    );

    const plain = `${dir}/none.client.tsx`;
    await writeFile(
      plain,
      `${HEAD}export default clientUrls(({ path }) => [path("/", P)]);\n`,
    );
    expect(await load.call(env("rsc"), `${plain}?rango-revalidate`)).toBe(
      "export {};\n",
    );
    expect(await load.call(env("rsc"), file)).toBeUndefined();
  });

  it("registers a .use predicate wherever its file sits: a sibling workspace package, outside the Vite root", async () => {
    const ws = normalizePath(join(dir, "ws"));
    const web = `${ws}/apps/web`;
    const groupFile = `${web}/src/app.urls.tsx`;
    const dashboard = `${ws}/packages/ui/src/Dashboard.tsx`;
    const predicate = "({ isAction }) => isAction(StatsActions)";
    const dashboardSource = `import { loader, revalidate } from "@rangojs/router/client";
import * as StatsActions from "./stats.actions";
export function Dashboard() {
  return null;
}
Dashboard.use = () => [loader(StatsLoader, () => [revalidate(${predicate})])];
`;
    await mkdir(dirname(groupFile), { recursive: true });
    await mkdir(dirname(dashboard), { recursive: true });
    await writeFile(
      groupFile,
      `"use client";
import { clientUrls } from "@rangojs/router/client";
import { Dashboard } from "@acme/ui";
export default clientUrls(({ path }) => [path("/", Dashboard)]);
`,
    );
    await writeFile(dashboard, dashboardSource);
    const resolver = {
      environment: { name: "rsc" },
      async resolve(source: string) {
        return source === "./stats.actions"
          ? { id: `${ws}/packages/ui/src/stats.actions.ts` }
          : null;
      },
    };
    const index = createClientUrlRevalidateIndex();
    const { load, transform } = hooks(web, index);
    await transform.call(env("ssr"), dashboardSource, dashboard);
    const key = revalidateKey("../../packages/ui/src/Dashboard.tsx", predicate);
    expect(index.fileByKey.get(key)).toBe(dashboard);

    index.filesByGroup.set(groupFile, [dashboard]);
    expect(await load.call(resolver, `${groupFile}?rango-revalidate`)).toBe(
      `import ${JSON.stringify(`${dashboard}?rango-revalidate`)};\n`,
    );
    expect(
      await load.call(resolver, `${dashboard}?rango-revalidate`),
    ).toContain(`  ${JSON.stringify(key)}: ${predicate},\n`);
  });

  describe("dev: a .use edit updates the group in the browser", () => {
    const head = `import { loader, loading } from "@rangojs/router/client";
export function Page() {
  return null;
}
`;
    const withUse = `${head}Page.use = () => [loading("a")];\n`;

    async function setup() {
      const plugin = clientUrlsRevalidateHoistPlugin(
        createClientUrlRevalidateIndex(),
      )[2]!;
      const file = `${dir}/hmr/Page.tsx`;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, withUse);
      const transform = (plugin.transform as unknown as ObjectHook).handler;
      await transform.call({ environment: { name: "client" } }, withUse, file);
      const group = { id: `${dir}/hmr/app.urls.tsx` };
      const page = { id: file, importers: new Set([group]) };
      const hotUpdate = (source: string) =>
        (plugin.hotUpdate as Hook).call(
          { environment: { name: "client" } },
          { file, modules: [page], read: async () => source },
        );
      return { plugin, transform, hotUpdate, page, group };
    }

    it("runs in the client environment of the dev server only", () => {
      const plugin = clientUrlsRevalidateHoistPlugin(
        createClientUrlRevalidateIndex(),
      )[2]!;
      expect(plugin.apply).toBe("serve");
      const applies = plugin.applyToEnvironment as (env: {
        name: string;
      }) => boolean;
      expect(applies({ name: "client" })).toBe(true);
      expect(applies({ name: "ssr" })).toBe(false);
      expect(applies({ name: "rsc" })).toBe(false);
    });

    it("keeps Fast Refresh for a save that leaves every .use unchanged", async () => {
      const { hotUpdate } = await setup();
      expect(
        await hotUpdate(withUse.replace("return null;", 'return "edited";')),
      ).toBeUndefined();
    });

    it("updates the importers too when a .use changes, goes or comes back", async () => {
      const { hotUpdate, page, group } = await setup();
      expect(
        await hotUpdate(withUse.replace('loading("a")', 'loading("b")')),
      ).toEqual([page, group]);
      expect(await hotUpdate(head)).toEqual([page, group]);
      expect(await hotUpdate(head)).toBeUndefined();
      expect(await hotUpdate(withUse)).toEqual([page, group]);
    });
  });
});
