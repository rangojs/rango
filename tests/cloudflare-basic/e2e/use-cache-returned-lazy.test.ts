import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// A "use cache" function returns a lazy component that reads the session
// cookie behind React.cache data the page already loaded
// (src/use-cache-returned-tree-data.tsx). The page renders the decoded copy
// of the value's encode, so the read refuses inside the guard and fails the
// request, as the same read in the function body does; the first visitor's
// session is never served to the next.

function defineUseCacheReturnedLazyTests(f: Fixture) {
  test("a lazy in the returned value never serves one visitor's session to the next", async ({
    request,
  }) => {
    // A fresh entry per run: the store outlives the test.
    const url = f.url(
      `/use-cache-returned-lazy/p${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
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

    expect(secondBody).not.toContain("session=alice");
    expect([first.status(), second.status()]).toEqual([500, 500]);
    expect(firstBody).not.toContain("session=alice");
  });
}

test.describe("use cache returned lazy (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineUseCacheReturnedLazyTests(f);
});

test.describe("use cache returned lazy (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineUseCacheReturnedLazyTests(f);
});
