import { urls } from "@rangojs/router";
import { SlowActionTrigger } from "./components/SlowActionTrigger.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const urlpatterns = urls(({ path }) => [
  // Fast routes (control: should NOT timeout)
  path("/", () => <div data-testid="index-page">Home</div>, { name: "home" }),
  path(
    "/timeout/fast-render",
    () => <div data-testid="fast-render">Fast render</div>,
    { name: "timeout.fastRender" },
  ),
  path.json("/timeout/fast-response", () => ({ ok: true }), {
    name: "timeout.fastResponse",
  }),

  // Slow routes (should trigger timeout at 10000ms)
  path(
    "/timeout/slow-render",
    async () => {
      await delay(20000);
      return <div data-testid="slow-render">Should not render</div>;
    },
    { name: "timeout.slowRender" },
  ),
  path.json(
    "/timeout/slow-response",
    async () => {
      await delay(20000);
      return { shouldNotReturn: true };
    },
    { name: "timeout.slowResponse" },
  ),

  // Action test page
  path(
    "/timeout/slow-action",
    () => (
      <div data-testid="slow-action-page">
        <SlowActionTrigger />
      </div>
    ),
    { name: "timeout.slowAction" },
  ),

  // Test endpoint to read onError state
  path.json("/__test/last-error", async () => {
    const { lastOnErrorCall, resetLastOnErrorCall } =
      await import("./router.js");
    const result = lastOnErrorCall;
    resetLastOnErrorCall();
    return result;
  }),
]);
