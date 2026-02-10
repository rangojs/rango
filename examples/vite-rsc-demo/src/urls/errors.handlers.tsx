import type { Handler } from "@rangojs/router";
import type { routes } from "./errors.gen.js";

export const ErrorsThrowHandler: Handler<"throwError", routes> = () => {
  throw new Error("Simulated handler error - something went wrong!");
};

export const ErrorsUnhandledHandler: Handler<"errors.unhandled", routes> = () => {
  throw new Error("This error is NOT caught by any route error boundary - it bubbles to root");
};
