// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { renderRoute } from "../render-route.js";

// The suspense audit (suspense-audit.ts) keeps its records per module, and
// vitest keeps a module per file. A root a test unmounts is gone: the next
// root's first mount of the same outlets is a mount, not an I4 remount.

function Layout(): ReactNode {
  return (
    <main>
      <Outlet />
    </main>
  );
}

function Page(): ReactNode {
  return <p data-testid="page">page</p>;
}

const routes = [
  { path: "/", Component: Layout },
  { path: "/shop", Component: Page },
];

let errors: ReturnType<typeof vi.spyOn>;
const audited = (): string[] =>
  errors.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((text: string) => text.startsWith("[rango][suspense]"));

beforeEach(() => {
  errors = vi.spyOn(console, "error");
});

afterEach(() => {
  errors.mockRestore();
});

it("a root mounts its outlets", async () => {
  const { findByTestId } = await renderRoute(routes, { request: "/shop" });
  await findByTestId("page");
  expect(audited()).toEqual([]);
});

it("a root in the next test mounts the same outlets without a remount", async () => {
  const { findByTestId } = await renderRoute(routes, { request: "/shop" });
  await findByTestId("page");
  expect(audited()).toEqual([]);
});

it("a second root in one test mounts the same outlets without a remount", async () => {
  const first = await renderRoute(routes, { request: "/shop" });
  await first.findByTestId("page");
  cleanup();
  const second = await renderRoute(routes, { request: "/shop" });
  await second.findByTestId("page");
  expect(audited()).toEqual([]);
});
