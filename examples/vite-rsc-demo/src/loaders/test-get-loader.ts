import { createLoader } from "rsc-router";

/**
 * Test fetchable loader for GET-based fetching
 * This loader registers itself in the server-side registry
 */
export const TestGetLoader = createLoader(
  "test-get",
  async (ctx) => {
    "use server";

    console.log("[TestGetLoader] Called with:", {
      method: ctx.method,
      params: ctx.params,
    });

    // Simulate some data fetching
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      message: "Hello from GET-based loader!",
      params: ctx.params,
      method: ctx.method,
      timestamp: new Date().toISOString(),
    };
  },
  true // fetchable - registers in server-side loader registry
);
