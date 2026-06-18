import { describe, it, expect } from "vitest";

// H4: the RSC entry of @rangojs/router/client (client.rsc.tsx, selected under
// the `react-server` condition) must forward the same "use client" hook set as
// the default entry (client.tsx). Previously ~10 hooks were silently omitted,
// so a consumer importing e.g. useParams from "@rangojs/router/client" in a
// module evaluated under react-server got an undefined named export.
//
// This suite runs under the vitest.rsc.config.ts project (react-server
// condition + rangoUseClientTransform), so importing client.rsc.tsx resolves
// the same way a consumer's react-server graph would. Each forwarded hook is a
// client reference object (defined), not undefined.
import * as clientRsc from "../client.rsc.js";

// Hooks the default ./client entry exports that the RSC entry MUST also forward.
const REQUIRED_HOOKS = [
  // already forwarded before H4
  "useLoader",
  "useHref",
  "useReverse",
  "useHandle",
  "useLocationState",
  // added by H4
  "useFetchLoader",
  "useRefreshLoaders",
  "useRouter",
  "usePathname",
  "useSearchParams",
  "useParams",
  "useMount",
  "useSegments",
  "useLinkStatus",
  "useScrollRestoration",
] as const;

describe("client.rsc entry hook surface (H4)", () => {
  it("forwards every default-entry hook (defined under react-server)", () => {
    const missing = REQUIRED_HOOKS.filter(
      (name) => (clientRsc as Record<string, unknown>)[name] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("still omits client-only navigation/action hooks by design", () => {
    const surface = clientRsc as Record<string, unknown>;
    // useNavigation / useAction drive client-only state and are intentionally
    // NOT re-exported from the RSC entry.
    expect(surface.useNavigation).toBeUndefined();
    expect(surface.useAction).toBeUndefined();
  });
});
