import { describe, expect, it } from "vitest";
import * as rootRscEntry from "../index.rsc.js";
import * as clientRscEntry from "../client.rsc.js";
import * as testingFlightEntry from "../testing/flight.entry.js";

// The react-server half of location-state-version-surface.test.tsx: these
// entries resolve under the `react-server` condition (vitest.rsc.config.ts).
// The server never records a version on location state (the client does, when
// it stores the state in a history entry), so all there is to pin is that no
// export hands one out.

const ENTRIES: Record<string, Record<string, unknown>> = {
  "@rangojs/router (react-server)": rootRscEntry,
  "@rangojs/router/client (react-server)": clientRscEntry,
  "@rangojs/router/testing/flight": testingFlightEntry,
};

describe("the version of location state is not public (react-server entries)", () => {
  it.each(Object.keys(ENTRIES))("%s exports nothing named after it", (name) => {
    expect(
      Object.keys(ENTRIES[name]!).filter((key) => /version/i.test(key)),
    ).toEqual([]);
  });

  it("a definition has no version property", () => {
    const Flash = rootRscEntry.createLocationState<{ text: string }>({
      flash: true,
    });
    expect(
      Object.getOwnPropertyNames(Flash).filter((key) => /version/i.test(key)),
    ).toEqual([]);
  });
});
