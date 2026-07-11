import { describe, expect, it, vi } from "vitest";
import {
  DEV_DISCOVERY_QUERY_EVENT,
  DEV_DISCOVERY_READY_EVENT,
} from "../dev-discovery-protocol.js";
import {
  startDevDiscoveryHandshake,
  type DevDiscoveryHot,
} from "./dev-discovery.js";

interface Harness {
  hot: DevDiscoveryHot;
  emit(payload: unknown): void;
  connect(): void;
  reload: () => void;
}

function createHarness(): Harness {
  const listeners = new Map<string, (payload: unknown) => void>();
  const on = vi.fn<DevDiscoveryHot["on"]>((event, listener): void => {
    listeners.set(event, listener);
  });

  return {
    hot: { on, send: vi.fn<DevDiscoveryHot["send"]>() },
    emit(payload: unknown): void {
      listeners.get(DEV_DISCOVERY_READY_EVENT)?.(payload);
    },
    connect(): void {
      listeners.get("vite:ws:connect")?.(undefined);
    },
    reload: vi.fn<() => void>(),
  };
}

describe("startDevDiscoveryHandshake", () => {
  it("queries the ready epoch after registering both listeners", () => {
    const order: string[] = [];
    const hot: DevDiscoveryHot = {
      on(event): void {
        order.push(event);
      },
      send(event): void {
        order.push(event);
      },
    };

    startDevDiscoveryHandshake(1, hot, { reload: vi.fn() });

    expect(order).toEqual([
      DEV_DISCOVERY_READY_EVENT,
      "vite:ws:connect",
      DEV_DISCOVERY_QUERY_EVENT,
    ]);
  });

  it("reloads when a ready event has a newer epoch", () => {
    const harness = createHarness();

    startDevDiscoveryHandshake(3, harness.hot, { reload: harness.reload });
    harness.emit({ epoch: 4 });

    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("queries the ready epoch again after reconnecting", () => {
    const harness = createHarness();

    startDevDiscoveryHandshake(3, harness.hot, { reload: harness.reload });
    harness.connect();

    expect(harness.hot.send).toHaveBeenCalledTimes(2);
    expect(harness.hot.send).toHaveBeenLastCalledWith(
      DEV_DISCOVERY_QUERY_EVENT,
      { epoch: 3 },
    );
  });

  it("reloads once when multiple events report a newer epoch", () => {
    const harness = createHarness();

    startDevDiscoveryHandshake(1, harness.hot, { reload: harness.reload });
    harness.emit({ epoch: 2 });
    harness.emit({ epoch: 3 });

    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("ignores equal, older, and malformed epochs", () => {
    const harness = createHarness();

    startDevDiscoveryHandshake(5, harness.hot, { reload: harness.reload });
    harness.emit({ epoch: 5 });
    harness.emit({ epoch: 4 });
    harness.emit({ epoch: -1 });
    harness.emit({ epoch: Number.POSITIVE_INFINITY });
    harness.emit({ epoch: "6" });
    harness.emit({});
    harness.emit(null);

    expect(harness.reload).not.toHaveBeenCalled();
  });

  it.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"])(
    "is inert for invalid document epoch %p",
    (documentEpoch) => {
      const harness = createHarness();

      startDevDiscoveryHandshake(documentEpoch, harness.hot, {
        reload: harness.reload,
      });

      expect(harness.hot.on).not.toHaveBeenCalled();
      expect(harness.hot.send).not.toHaveBeenCalled();
      expect(harness.reload).not.toHaveBeenCalled();
    },
  );
});
