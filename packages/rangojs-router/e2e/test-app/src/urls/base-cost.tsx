import { urls, createLoader } from "@rangojs/router";
import { Suspense } from "react";
import { Link, Outlet } from "@rangojs/router/client";
import { BaseCostValue } from "../components/BaseCost.js";

const run = async (ctx: any) => {
  const delay = Number(ctx.searchParams.get("delay") ?? 0) || 0;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return { delay };
};

export const BcSkeletonLoader = createLoader(run);
export const BcBareLoader = createLoader(run);
export const BcNestedLoader = createLoader(run);
export const BcVtLoader = createLoader(run);
export const BcVtOffLoader = createLoader(run);
export const BcVtBareLoader = createLoader(run);

const run2 = async (ctx: any) => {
  const delay = (Number(ctx.searchParams.get("delay") ?? 0) || 0) + 300;
  await new Promise((r) => setTimeout(r, delay));
  return { delay };
};
export const BcTwoALoader = createLoader(run);
export const BcTwoBLoader = createLoader(run2);
export const BcTwoOffALoader = createLoader(run);
export const BcTwoOffBLoader = createLoader(run2);
export const BcInnerLoader = createLoader(run);
export const BcVtInnerLoader = createLoader(run);
export const BcVtInnerOffLoader = createLoader(run);

const fb = (id: string) => <div data-testid={id}>loading {id}</div>;
const CASES = [
  "skeleton",
  "bare",
  "nested",
  "vt",
  "vt-off",
  "vt-bare",
  "vt-two",
  "vt-two-off",
  "vt-inner",
  "vt-inner-off",
  "inner",
];

const twoPage = (id: string, a: any, b: any) => () => (
  <div data-testid={`bc-${id}-page`}>
    <BaseCostValue loader={a} testId="bc-value" />
    <BaseCostValue loader={b} testId="bc-value-b" />
  </div>
);
const innerPage = (id: string, l: any) => () => (
  <div data-testid={`bc-${id}-page`}>
    <Suspense fallback={fb("bc-fb-in")}>
      <BaseCostValue loader={l} testId="bc-value" />
    </Suspense>
  </div>
);

const Hub = () => (
  <div data-testid="bc-hub">
    {CASES.flatMap((c) =>
      [0, 50, 100, 200, 280, 300, 320, 400, 500].map((d) => (
        <Link
          key={`${c}-${d}`}
          to={`/base-cost/${c}?delay=${d}`}
          prefetch="none"
          data-testid={`bc-link-${c}-${d}`}
        >
          {c}
        </Link>
      )),
    )}
    <div data-testid="bc-outlet">
      <Outlet />
    </div>
  </div>
);

const NestedLayout = () => (
  <div data-testid="bc-nested-layout">
    <Outlet />
  </div>
);

const page = (id: string, loader: any) => () => (
  <div data-testid={`bc-${id}-page`}>
    <BaseCostValue loader={loader} testId="bc-value" />
  </div>
);

export const baseCostPatterns = urls(
  ({ path, layout, loader, loading, transition }) => [
    layout(Hub, () => [
      path("/", () => <div data-testid="bc-index">hub</div>, { name: "index" }),
      path(
        "/skeleton",
        page("skeleton", BcSkeletonLoader),
        { name: "skeleton" },
        () => [loader(BcSkeletonLoader), loading(fb("bc-fb"))],
      ),
      path("/bare", page("bare", BcBareLoader), { name: "bare" }, () => [
        loader(BcBareLoader),
      ]),
      layout(NestedLayout, () => [
        loading(fb("bc-fb-outer")),
        path(
          "/nested",
          page("nested", BcNestedLoader),
          { name: "nested" },
          () => [loader(BcNestedLoader), loading(fb("bc-fb-inner"))],
        ),
      ]),
      path("/vt", page("vt", BcVtLoader), { name: "vt" }, () => [
        loader(BcVtLoader),
        loading(fb("bc-fb")),
        transition(),
      ]),
      path("/vt-off", page("vt-off", BcVtOffLoader), { name: "vtOff" }, () => [
        loader(BcVtOffLoader),
        loading(fb("bc-fb")),
        transition({ viewTransition: false }),
      ]),
      path(
        "/vt-bare",
        page("vt-bare", BcVtBareLoader),
        { name: "vtBare" },
        () => [loader(BcVtBareLoader), transition()],
      ),
      path(
        "/vt-two",
        twoPage("vt-two", BcTwoALoader, BcTwoBLoader),
        { name: "vtTwo" },
        () => [
          loader(BcTwoALoader),
          loader(BcTwoBLoader),
          loading(fb("bc-fb")),
          transition(),
        ],
      ),
      path(
        "/vt-two-off",
        twoPage("vt-two-off", BcTwoOffALoader, BcTwoOffBLoader),
        { name: "vtTwoOff" },
        () => [
          loader(BcTwoOffALoader),
          loader(BcTwoOffBLoader),
          loading(fb("bc-fb")),
          transition({ viewTransition: false }),
        ],
      ),
      path(
        "/vt-inner",
        innerPage("vt-inner", BcVtInnerLoader),
        { name: "vtInner" },
        () => [loader(BcVtInnerLoader), loading(fb("bc-fb")), transition()],
      ),
      path(
        "/vt-inner-off",
        innerPage("vt-inner-off", BcVtInnerOffLoader),
        { name: "vtInnerOff" },
        () => [
          loader(BcVtInnerOffLoader),
          loading(fb("bc-fb")),
          transition({ viewTransition: false }),
        ],
      ),
      path(
        "/inner",
        innerPage("inner", BcInnerLoader),
        { name: "inner" },
        () => [loader(BcInnerLoader), loading(fb("bc-fb"))],
      ),
    ]),
  ],
);
