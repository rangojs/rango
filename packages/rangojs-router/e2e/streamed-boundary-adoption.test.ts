import { test } from "@playwright/test";
import { expectStreamedBoundariesAdopted } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError } from "./helper";

// /slow-streaming has one loading() boundary that resolves after hydration
// (1s loader). Contract and mechanism: expectStreamedBoundariesAdopted.
function boundaryAdoptionTests(f: Fixture, mode: "dev" | "build") {
  test("a boundary that resolves after hydration adopts the streamed server HTML", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectStreamedBoundariesAdopted(page, {
      url: f.url("/slow-streaming"),
      mode,
      contentTestIds: ["slow-streaming-message"],
    });
  });
}

test.describe("streamed boundary adoption", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  boundaryAdoptionTests(f, "dev");
});

test.describe("streamed boundary adoption (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  boundaryAdoptionTests(f, "build");
});
