import { notFound } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

export function StreamedHandlerBoundaryIndex() {
  return (
    <div data-testid="shb-index">
      <Link to="/streamed-handler-boundary/fails" data-testid="shb-fails-link">
        Streamed handler error
      </Link>
      <Link
        to="/streamed-handler-boundary/fails-no-ssr"
        data-testid="shb-no-ssr-link"
      >
        Streamed handler error (ssr: false)
      </Link>
      <Link
        to="/streamed-handler-boundary/missing"
        data-testid="shb-missing-link"
      >
        Streamed handler notFound
      </Link>
      <Link
        to="/streamed-handler-boundary/slot-ancestor"
        data-testid="shb-slot-link"
      >
        Slot failure (ancestor boundary)
      </Link>
      <Link
        to="/streamed-handler-boundary/undeclared"
        data-testid="shb-undeclared-link"
      >
        Streamed handler error (no declared boundary)
      </Link>
    </div>
  );
}

export async function StreamedHandlerBoundaryFails(): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  throw new Error("streamed handler failed after the response started");
}

export async function StreamedHandlerBoundaryMissing(): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  notFound("streamed handler resource is missing");
}

export function StreamedHandlerBoundaryLoading({ id }: { id: string }) {
  return <p data-testid={`${id}-loading`}>Loading...</p>;
}

export function StreamedHandlerBoundaryError({ id }: { id: string }) {
  return <p data-testid={`${id}-fallback`}>Declared error fallback</p>;
}

export function StreamedHandlerBoundaryNotFound() {
  return <p data-testid="shb-missing-fallback">Declared not-found fallback</p>;
}

let flakyFailing = true;

/** Every flaky run fails until healed (a capture or re-render fails too). */
export function StreamedHandlerBoundaryReset(): { ok: true } {
  flakyFailing = true;
  return { ok: true };
}

export function StreamedHandlerBoundaryHeal(): { ok: true } {
  flakyFailing = false;
  return { ok: true };
}

const flaky = () => async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (flakyFailing) throw new Error("flaky failing until healed");
  return <p data-testid="shb-flaky-healthy">healthy</p>;
};

export const StreamedHandlerBoundaryFlakyCache = flaky();
export const StreamedHandlerBoundaryFlakyPpr = flaky();

export async function StreamedHandlerBoundarySlotFails(): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  throw new Error("slot failed after the response started");
}
