import { describe, expect, it } from "vitest";
import { createLoaderDirectiveGuardPlugin } from "../plugins/expose-internal-ids.js";

function transform(code: string, id = "/project/src/catalog.loader.ts") {
  const plugin = createLoaderDirectiveGuardPlugin() as ReturnType<
    typeof createLoaderDirectiveGuardPlugin
  > & {
    transform: (this: any, code: string, id: string) => any;
  };
  return plugin.transform.call({ environment: { name: "rsc" } }, code, id);
}

describe("loader directive guard", () => {
  it("throws on an inline directive in an arrow createLoader body", () => {
    const code = `import { createLoader } from "@rangojs/router";
export const ProductLoader = createLoader(async (ctx) => {
  "use server";
  return ctx.params.slug;
});
`;
    expect(() => transform(code)).toThrow(
      /createLoader\(\) body at \/project\/src\/catalog\.loader\.ts:3 carries a "use server" directive/,
    );
  });

  it("throws on a function-expression body with a single-quoted directive", () => {
    const code = `import { createLoader } from "@rangojs/router";
export const L = createLoader(async function (ctx) {
  'use server';
  return 1;
}, true);
`;
    expect(() => transform(code)).toThrow(/catalog\.loader\.ts:3/);
  });

  it("sees through a generic call and a bare (non-exported) binding", () => {
    const code = `import { createLoader } from "@rangojs/router";
const Featured = createLoader<{ items: string[] }>(async () => {
  "use server";
  return { items: [] };
});
export { Featured };
`;
    expect(() => transform(code)).toThrow(/catalog\.loader\.ts:3/);
  });

  it("follows an aliased createLoader import", () => {
    const code = `import { createLoader as defineLoader } from "@rangojs/router";
export const L = defineLoader(async () => {
  "use server";
  return 1;
});
`;
    expect(() => transform(code)).toThrow(/carries a "use server" directive/);
  });

  it("strips a query suffix from the reported id", () => {
    const code = `import { createLoader } from "@rangojs/router";
export const L = createLoader(async () => {
  "use server";
  return 1;
});
`;
    expect(() => transform(code, "/project/src/x.ts?v=123")).toThrow(
      /\/project\/src\/x\.ts:3 /,
    );
  });

  it("passes a loader body without a directive", () => {
    const code = `import { createLoader } from "@rangojs/router";
export const L = createLoader(async (ctx) => {
  const x = "use server";
  return x;
});
`;
    expect(transform(code)).toBeUndefined();
  });

  it("ignores directives in non-loader functions of the same module", () => {
    const code = `import { createLoader } from "@rangojs/router";
export async function save() {
  "use server";
}
export const L = createLoader(async () => save());
`;
    expect(transform(code)).toBeUndefined();
  });

  it("ignores modules without a createLoader import", () => {
    const code = `import { createLoader } from "./my-loader-factory.js";
export const L = createLoader(async () => {
  "use server";
  return 1;
});
`;
    expect(transform(code)).toBeUndefined();
  });

  it("skips node_modules", () => {
    const code = `import { createLoader } from "@rangojs/router";
export const L = createLoader(async () => {
  "use server";
  return 1;
});
`;
    expect(
      transform(code, "/project/node_modules/pkg/loader.ts"),
    ).toBeUndefined();
  });
});
