import { urls } from "@rangojs/router";
import { ContextDedupLayout } from "../components/layouts/ContextDedupLayout.js";
import { ContextDedupConsumer } from "../components/ContextDedupConsumer.js";

export const contextDedupPatterns = urls(({ path, layout }) => [
  layout(ContextDedupLayout, () => [
    path(
      "/",
      () => (
        <div data-testid="context-dedup-page">
          <h1>Context Dedup Test</h1>
          <ContextDedupConsumer />
        </div>
      ),
      { name: "contextDedupIndex" },
    ),
  ]),
]);
