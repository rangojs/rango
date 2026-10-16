import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import { defineSsrShellErrorTests } from "@shared/e2e";

// dc-t93 on workerd: a server-render shell error answers a recovery document
// in production and keeps the host's overlay in dev. Fixture:
// src/pages/holey-throws.tsx. Own server, so the onError log and the server's
// output belong to this suite.

type Fixture = ReturnType<typeof useFixture>;

const serverOutput = (f: Fixture) => (): string =>
  f.proc().stdout() + f.proc().stderr();

test.describe("ssr shell error", () => {
  const f = useFixture({ root: ".", mode: "dev", isolatedServer: true });
  defineSsrShellErrorTests(() => ({
    url: (p) => f.url(p),
    production: false,
    serverOutput: serverOutput(f),
  }));
});

test.describe("ssr shell error (production)", () => {
  const f = useFixture({ root: ".", mode: "build", isolatedServer: true });
  defineSsrShellErrorTests(() => ({
    url: (p) => f.url(p),
    production: true,
    serverOutput: serverOutput(f),
  }));
});
