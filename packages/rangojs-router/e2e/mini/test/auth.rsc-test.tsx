import { describe, expect, it } from "vitest";
import { renderHandler } from "@rangojs/router/testing/flight";
import { cookies, getRequestContext } from "@rangojs/router";
import { FlashMessage } from "../src/shared.js";

// The /login route's inline server actions stay on the page: they set the session
// cookie and the flash with getRequestContext().setLocationState() and return void
// (no redirect). The route's own action closures can't be imported, so this pins
// the MECHANISM they rely on — set cookie + set location state with NO redirect —
// through the public harness: renderHandler runs the void action body in a request
// context, and its result captures the Set-Cookie and the location state, with no
// Location header. This is the no-redirect flash-on-same-page path the route uses.
describe("mini login mechanism (cookie + flash, no redirect)", () => {
  it("sets a session cookie and a welcome flash, without redirecting", async () => {
    const result = await renderHandler(
      () => {
        cookies().set("session", "Alice", { httpOnly: true, path: "/" });
        getRequestContext().setLocationState(
          FlashMessage({ text: "Welcome back, Alice!" }),
        );
        // No redirect, no Response — render nothing; we assert the side effects.
        return null;
      },
      { request: "/login", headers: { "rsc-action": "1" } },
    );

    expect(result.response.headers.get("Location")).toBeNull();
    expect(
      result.response.headers
        .getSetCookie()
        .some((c: string) => c.startsWith("session=Alice")),
    ).toBe(true);
    expect(JSON.stringify(result.locationState)).toContain(
      "Welcome back, Alice!",
    );
  });

  it("logout mechanism: clears the session cookie and flashes, no redirect", async () => {
    const result = await renderHandler(
      () => {
        cookies().delete("session", { path: "/" });
        getRequestContext().setLocationState(
          FlashMessage({ text: "Signed out." }),
        );
        return null;
      },
      {
        request: "/login",
        headers: { "rsc-action": "1", cookie: "session=Alice" },
      },
    );

    expect(result.response.headers.get("Location")).toBeNull();
    expect(
      result.response.headers
        .getSetCookie()
        .some((c: string) => c.startsWith("session=")),
    ).toBe(true);
    expect(JSON.stringify(result.locationState)).toContain("Signed out.");
  });
});
