import { createHandle } from "@rangojs/router";

// Custom handle pushed from the intercept handler during build-time intercept
// prerendering (#567 gap 1). Kept in its own module so the client consumer
// (InterceptHandleDisplay) can import the handle without pulling the server
// urls file into the client graph.
export const InterceptCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
