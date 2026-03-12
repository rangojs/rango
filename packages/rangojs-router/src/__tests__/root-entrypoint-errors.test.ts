import { describe, expect, it } from "vitest";
import { createRouter, layout, urls } from "../index";

const expectedGuidance =
  'only available from "@rangojs/router" in a react-server/RSC environment';
const clientGuidance = 'import from "@rangojs/router/client"';

describe("root entrypoint server-only stubs", () => {
  it("explains the environment contract for createRouter", () => {
    expect(() => createRouter()).toThrowError(expectedGuidance);
    expect(() => createRouter()).toThrowError(clientGuidance);
  });

  it("explains the environment contract for urls and route helpers", () => {
    expect(() => urls()).toThrowError(expectedGuidance);
    expect(() => layout()).toThrowError(expectedGuidance);
    expect(() => layout()).toThrowError(clientGuidance);
  });
});
