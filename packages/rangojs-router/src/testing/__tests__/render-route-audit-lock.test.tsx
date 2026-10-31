// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderRoute } from "../render-route.js";

// The router's unit suite fails a test the suspense audit reports a
// violation in (src/__tests__/kit/suspense-audit-lock.ts). Printed on
// console.error alone, 368 reports went unread (rango-t226).

const routes = [{ path: "/", Component: () => <p data-testid="page">home</p> }];

// Set where the body ends: the failure it.fails expects is the lock's, after
// the body passed, not one of the body's own.
let bodyPassed = false;

it.fails("a tree update that names no cause fails its test (I6)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { router, findByTestId } = await renderRoute(routes, {
    request: "/",
  });
  await act(async () => {
    router.store.emitUpdate({
      root: <p data-testid="page">next</p>,
      metadata: { pathname: "/", segments: [] },
    });
  });
  expect((await findByTestId("page")).textContent).toBe("next");
  bodyPassed = true;
});

it("a test after it starts with no audit records", async () => {
  expect(bodyPassed).toBe(true);
  const { findByTestId } = await renderRoute(routes, { request: "/" });
  await findByTestId("page");
  const report = (
    window as unknown as { __rangoSuspenseAudit: { uncaused: number } }
  ).__rangoSuspenseAudit;
  expect(report.uncaused).toBe(0);
});
