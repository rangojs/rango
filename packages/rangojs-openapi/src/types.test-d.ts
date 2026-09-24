/* eslint-disable no-unused-expressions -- intentional type-probe expressions in a .test-d file */
// Compile-time proof of the flat verb-operation generics (DESIGN.md §8). No
// runtime assertions — the value is that `tsc --strict` accepts the positives and
// every `@ts-expect-error` negative fires. Exercised against api-shop operations
// incl. the multi-verb `/cart` path and the operationId-keyed type-only client.
import {
  api,
  createClient,
  type StandardSchemaV1,
  type InferOutput,
} from "./types.ts";

// --- tiny Standard Schema builder (stand-in for zod; real zod drops in) ---
type Std<O> = StandardSchemaV1<O, O>;
const leaf = <O>(): Std<O> =>
  ({
    "~standard": {
      version: 1,
      vendor: "mock",
      validate: (v) => ({ value: v as O }),
    },
  }) as Std<O>;
type ObjOut<Shape extends Record<string, StandardSchemaV1>> = {
  [K in keyof Shape as undefined extends InferOutput<Shape[K]>
    ? never
    : K]: InferOutput<Shape[K]>;
} & {
  [K in keyof Shape as undefined extends InferOutput<Shape[K]>
    ? K
    : never]?: InferOutput<Shape[K]>;
};
const s = {
  string: () => leaf<string>(),
  number: () => leaf<number>(),
  boolean: () => leaf<boolean>(),
  literal: <const L extends string | number | boolean>(_l: L) => leaf<L>(),
  array: <S extends StandardSchemaV1>(_s: S) => leaf<InferOutput<S>[]>(),
  optional: <S extends StandardSchemaV1>(_s: S) =>
    leaf<InferOutput<S> | undefined>(),
  object: <Shape extends Record<string, StandardSchemaV1>>(_shape: Shape) =>
    leaf<ObjOut<Shape>>(),
};

const CartItem = s.object({
  itemId: s.string(),
  productId: s.string(),
  quantity: s.number(),
});
const Product = s.object({
  id: s.string(),
  name: s.string(),
  price: s.number(),
});

// ============================================================================
// Contract — flat verb operations, multi-verb /cart path
// ============================================================================
const shop = api(
  ({ get, post, delete: del }) => [
    get("/catalog", {
      operationId: "listCatalog",
      query: s.object({ page: s.number() }),
      response: s.object({ products: s.array(Product), total: s.number() }),
      cache: { ttl: 60, swr: 300 },
      handler: (ctx) => ({
        products: [] as { id: string; name: string; price: number }[],
        total: ctx.query.page, // ctx.query typed from `query` schema
      }),
    }),
    get("/catalog/:productId", {
      operationId: "getProduct",
      response: s.object({ product: Product }),
      handler: (ctx) => {
        const id: string = ctx.params.productId; // params typed from the pattern
        return { product: { id, name: "x", price: 1 } };
      },
    }),
    get("/cart", {
      operationId: "getCart",
      response: s.object({ items: s.array(CartItem) }),
      handler: () => ({
        items: [] as { itemId: string; productId: string; quantity: number }[],
      }),
    }),
    post("/cart", {
      operationId: "addToCart",
      body: s.object({
        productId: s.string(),
        quantity: s.optional(s.number()),
      }),
      response: s.object({ items: s.array(CartItem), added: CartItem }),
      errors: [{ status: 404, code: "PRODUCT_NOT_FOUND" }],
      handler: (ctx) => {
        const pid: string = ctx.body.productId; // ctx.body typed from `body` schema
        const q: number | undefined = ctx.body.quantity; // optional field typed
        return {
          items: [],
          added: { itemId: "1", productId: pid, quantity: q ?? 1 },
        };
      },
    }),
    del("/cart", {
      operationId: "clearCart",
      response: s.object({ cleared: s.literal(true) }),
      handler: () => ({ cleared: true as const }),
    }),
  ],
  { info: { title: "Shop API", version: "1.0.0" }, ui: "scalar" },
);

// --- handler-side negatives ---
api(({ post }) => [
  post("/cart", {
    operationId: "bad1",
    body: s.object({ productId: s.string() }),
    response: s.object({ ok: s.boolean() }),
    // @ts-expect-error return must match `response` ({ ok: boolean }), not this
    handler: () => ({ wrong: 1 }),
  }),
]);
api(({ post }) => [
  post("/cart", {
    operationId: "bad2",
    body: s.object({ productId: s.string() }),
    response: s.object({ ok: s.boolean() }),
    handler: (ctx) => {
      // @ts-expect-error `quantity` is not on this body schema
      ctx.body.quantity;
      return { ok: true };
    },
  }),
]);

// ============================================================================
// Typed client — operationId-keyed, type-only (TContract = typeof shop)
// ============================================================================
async function _client() {
  // runtime input: a plain operationId -> pattern map (leaks nothing)
  const routes = {
    listCatalog: "/catalog",
    getProduct: "/catalog/:productId",
    getCart: "/cart",
    addToCart: "/cart",
    clearCart: "/cart",
  };
  const c = createClient<typeof shop>(routes, { baseUrl: "https://x" });

  (await c.getCart()).items[0]!.quantity.toFixed(); // typed number

  const r = await c.addToCart({ body: { productId: "p1", quantity: 2 } });
  r.added.itemId; // typed
  await c.addToCart({ body: { productId: "p1" } }); // quantity optional

  (await c.clearCart()).cleared satisfies true; // typed literal

  await c.getProduct({ params: { productId: "p1" } }); // params required + typed
  await c.listCatalog({ query: { page: 1 } }); // query optional
  await c.listCatalog(); // no required args -> callable bare

  // @ts-expect-error body.productId is required
  await c.addToCart({ body: { quantity: 2 } });
  // @ts-expect-error productId param required
  await c.getProduct();
  // @ts-expect-error unknown operation
  await c.nope();
}

void shop;
void _client;
