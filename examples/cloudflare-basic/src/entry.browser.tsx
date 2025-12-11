import React from "react";
import { hydrateRoot } from "react-dom/client";
import { createApp } from "rsc-router/browser";
import * as browserDeps from "@vitejs/plugin-rsc/browser";

async function main() {
  const App = await createApp({ deps: browserDeps });

  hydrateRoot(
    document.getElementById("root")!,
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

main();
