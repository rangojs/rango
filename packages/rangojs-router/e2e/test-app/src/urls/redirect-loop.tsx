import { redirect, urls } from "@rangojs/router";

// #1047: two pages whose route middleware redirect to each other forever.
export const redirectLoopPatterns = urls(({ path, middleware }) => [
  path(
    "/",
    () => (
      <div data-testid="redirect-loop-index">
        <h1>Redirect Loop</h1>
      </div>
    ),
    { name: "index" },
  ),
  path(
    "/ping",
    () => <div>ping</div>,
    { name: "ping" },
    () => [middleware(() => redirect("/redirect-loop/pong", 302))],
  ),
  path(
    "/pong",
    () => <div>pong</div>,
    { name: "pong" },
    () => [middleware(() => redirect("/redirect-loop/ping", 302))],
  ),
]);
