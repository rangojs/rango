import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath, transformWithOxc } from "vite";
import {
  clientUrlsRevalidateHoistPlugin,
  hoistClientUrlsRevalidates,
  parseHoistedRevalidateId,
  revalidateKey,
} from "../plugins/client-urls-revalidate-hoist.js";

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
): Promise<Error> {
  try {
    await hoist(code, deps);
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

  it("leaves a module alone without use client, without the router's clientUrls, or without the builder's helper", async () => {
    expect(
      await hoist(group("() => true").replace('"use client";\n', "")),
    ).toBeNull();
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

    it("a spread, a second argument, no argument, or a value that is not a function", async () => {
      for (const args of ["...fns", "() => true, extra", ""]) {
        expect((await hoistError(group(args))).message).toContain(
          "`revalidate()` takes exactly one predicate.",
        );
      }
      for (const value of ["{ ok: true }", "'yes'", "[]"]) {
        expect((await hoistError(group(value))).message).toContain(
          "`revalidate()` expects a predicate function.",
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
  function hooks(root: string) {
    const [pre, post] = clientUrlsRevalidateHoistPlugin();
    (pre!.configResolved as Hook).call({}, { root });
    return {
      transform: pre!.transform as Hook,
      load: pre!.load as Hook,
      register: post!.transform as Hook,
    };
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

  it("appends the registration import to the RSC proxy of a file with predicates only", async () => {
    const { transform, register } = hooks(dir);
    const id = `${dir}/proxy.client.tsx`;
    const proxy =
      'import * as $$ReactServer from "x";\nexport default $$ReactServer.registerClientReference(() => {}, "/proxy.client.tsx", "default");\n';

    await transform.call(env("rsc"), group("() => true"), id);
    const out = (await register.call(env("rsc"), proxy, id)) as {
      code: string;
    };
    expect(out.code).toBe(
      `${proxy}\nimport ${JSON.stringify(`${id}?rango-revalidate`)};\n`,
    );
    expect(await register.call(env("client"), proxy, id)).toBeUndefined();

    const plain = `${dir}/plain.client.tsx`;
    await transform.call(
      env("rsc"),
      `${HEAD}export default clientUrls(({ path }) => [path("/", P)]);\n`,
      plain,
    );
    expect(await register.call(env("rsc"), proxy, plain)).toBeUndefined();
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

  it("load serves the RSC transform's module, re-hoists an edited file from disk, and an empty module without predicates", async () => {
    const { transform, load } = hooks(dir);
    const file = `${dir}/served.client.tsx`;
    await writeFile(file, group("() => 'disk'"));
    // An earlier plugin changed the pipeline text: the transform's module wins.
    await transform.call(env("rsc"), group("() => 'pipeline'"), file);
    expect(await load.call({}, `${file}?rango-revalidate`)).toContain(
      "() => 'pipeline'",
    );

    await writeFile(file, group("() => 'edited'"));
    expect(await load.call({}, `${file}?rango-revalidate`)).toContain(
      "() => 'edited'",
    );

    const plain = `${dir}/none.client.tsx`;
    await writeFile(
      plain,
      `${HEAD}export default clientUrls(({ path }) => [path("/", P)]);\n`,
    );
    expect(await load.call({}, `${plain}?rango-revalidate`)).toBe(
      "export {};\n",
    );
    expect(await load.call({}, file)).toBeUndefined();
  });
});
