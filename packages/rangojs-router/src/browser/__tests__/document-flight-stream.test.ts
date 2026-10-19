import { describe, expect, it } from "vitest";
import {
  createDocumentFlightStream,
  type FlightDataHost,
} from "../document-flight-stream.js";

// A document whose DOMContentLoaded the test fires, trusted (the browser's
// own) or not (document.dispatchEvent from a script).
function fakeDocument(readyState: DocumentReadyState = "loading") {
  const listeners = new Set<(event: Event) => void>();
  const doc = {
    readyState,
    addEventListener: (_type: string, fn: (event: Event) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (event: Event) => void) => {
      listeners.delete(fn);
    },
  } as unknown as Pick<
    Document,
    "readyState" | "addEventListener" | "removeEventListener"
  >;
  const fire = (isTrusted: boolean): void => {
    for (const fn of [...listeners]) fn({ isTrusted } as Event);
  };
  return { doc, fire, listeners };
}

describe("createDocumentFlightStream", () => {
  it("delivers chunks pushed before and after it starts, in order", async () => {
    const { doc, fire } = fakeDocument();
    const host: FlightDataHost = { __FLIGHT_DATA: ["a"] };
    const stream = createDocumentFlightStream(doc, host);
    host.__FLIGHT_DATA!.push(new TextEncoder().encode("b"));
    host.__FLIGHT_DATA!.push("c");
    fire(true);
    expect(await new Response(stream).text()).toBe("abc");
  });

  it("stays open through a DOMContentLoaded a script dispatched and closes at the browser's (#1205)", async () => {
    const { doc, fire } = fakeDocument();
    const host: FlightDataHost = {};
    const stream = createDocumentFlightStream(doc, host);
    host.__FLIGHT_DATA!.push("a");
    fire(false);
    host.__FLIGHT_DATA!.push("b");
    fire(true);
    expect(await new Response(stream).text()).toBe("ab");
  });

  it("closes once: a DOMContentLoaded after the close does not throw (#1205)", () => {
    const { doc, fire, listeners } = fakeDocument();
    createDocumentFlightStream(doc, {});
    fire(true);
    expect(listeners.size).toBe(0);
    expect(() => {
      fire(true);
      fire(false);
    }).not.toThrow();
  });

  it("closes at once when the document already finished parsing", async () => {
    const { doc, listeners } = fakeDocument("interactive");
    const stream = createDocumentFlightStream(doc, { __FLIGHT_DATA: ["a"] });
    expect(listeners.size).toBe(0);
    expect(await new Response(stream).text()).toBe("a");
  });
});
