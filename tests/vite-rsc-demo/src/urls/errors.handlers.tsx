import type { Handler } from "@rangojs/router";

export const ErrorsThrowHandler: Handler<"errors.throwError"> = () => {
  throw new Error("Simulated handler error - something went wrong!");
};

export const ErrorsUnhandledHandler: Handler<"errors.unhandled"> = () => {
  throw new Error(
    "This error is NOT caught by any route error boundary - it bubbles to root",
  );
};
