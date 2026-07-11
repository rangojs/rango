import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { handleHandlerResult } from "../helpers.js";

describe("handleHandlerResult", () => {
  it("accepts one promise whose resolved value can be a node or Response", async () => {
    const nodeResult: Promise<ReactNode | Response> = Promise.resolve("page");
    await expect(handleHandlerResult(nodeResult)).resolves.toBe("page");

    const response = new Response(null, { status: 302 });
    const responseResult: Promise<ReactNode | Response> =
      Promise.resolve(response);
    await expect(handleHandlerResult(responseResult)).rejects.toBe(response);
  });
});
