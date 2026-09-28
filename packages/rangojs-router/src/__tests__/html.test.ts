import { describe, expect, it } from "vitest";
import * as client from "../client.js";
import { MetaTags } from "../handles/MetaTags.js";
import { Scripts } from "../handles/Scripts.js";
import { ScrollRestoration } from "../browser/react/ScrollRestoration.js";

describe("Html namespace", () => {
  it("maps each member to its underlying component", () => {
    const { Html } = client;
    expect(Object.keys(Html)).toEqual(["Meta", "Scripts", "ScrollRestoration"]);
    expect(Html.Meta).toBe(MetaTags);
    expect(Html.Scripts).toBe(Scripts);
    expect(Html.ScrollRestoration).toBe(ScrollRestoration);
  });

  // An object literal would bundle every member into any app importing Html.
  it("is a module namespace, so bundlers drop members an app never renders", () => {
    expect(Object.prototype.toString.call(client.Html)).toBe("[object Module]");
  });

  it("is the only document-component export of the default client entry", () => {
    const surface = client as Record<string, unknown>;
    for (const removed of ["MetaTags", "Scripts", "ScrollRestoration"]) {
      expect(surface[removed], removed).toBeUndefined();
    }
  });
});
