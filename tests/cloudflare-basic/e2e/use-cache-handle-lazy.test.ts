import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// A "use cache" function pushes lazy state that reads the session cookie into
// a handle (a React.lazy, a memoizing thenable, or one a loader it reads
// pushes) and returns a value whose encode outlasts the handler
// (src/use-cache-handle-lazy-data.tsx). The pushes are encoded inside the
// guard and the page gets their decoded copy, so the response's render never
// starts the lazy state with the first visitor's session, and the entry never
// serves it to the next.

function defineUseCacheHandleLazyTests(f: Fixture) {
  for (const shape of ["lazy-component", "thenable", "loader-thenable"]) {
    test(`${shape} pushed into a handle never serves one visitor's session to the next`, async ({
      request,
    }) => {
      // A fresh entry per run: the store outlives the test.
      const url = f.url(
        `/use-cache-handle-lazy/${shape}/p${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      );
      const first = await request.get(url, {
        headers: { cookie: "session=alice" },
      });
      // Let the first request's background store write land.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = await request.get(url, {
        headers: { cookie: "session=bob" },
      });
      const [firstBody, secondBody] = [await first.text(), await second.text()];

      expect(secondBody).toContain("handle-lazy-slow-leaf");
      expect(secondBody).not.toContain("session=alice");
      expect(firstBody).toContain("handle-lazy-slow-leaf");
      expect(firstBody).not.toContain("session=alice");
    });
  }
}

test.describe("use cache handle lazy (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineUseCacheHandleLazyTests(f);
});

test.describe("use cache handle lazy (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineUseCacheHandleLazyTests(f);
});
