import "./index.css"; // css import is automatically injected in exported server components
import viteLogo from "/vite.svg";
import { getServerCounter, updateServerCounter } from "./action.tsx";
import reactLogo from "./assets/react.svg";
import { ClientCounter } from "./client.tsx";
// import { Homepage, HomepageLoading } from "./Homepage.tsx";
// import { AdvancedRscExample } from "./AdvancedRscExample.tsx";
// import { Suspense } from "react";
import { Partial } from "./components/partial.server.tsx";
import { DynamicRscLoader } from "./DynamicRscLoader.tsx";
import { TempAwaitText } from "./components/tempAwaitText.tsx";
import { ServerCounterClient } from "./components/server-counter.client.tsx";

export function Root(props: { url: URL }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <link rel="icon" type="image/svg+xml" href="/vite.svg" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Vite + RSC</title>
      </head>
      <body>
        <App {...props} />
      </body>
    </html>
  );
}

function App(props: { url: URL }) {
  return (
    <div id="root">
      <div>
        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a
          href="https://react.dev/reference/rsc/server-components"
          target="_blank"
        >
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <TempAwaitText
        promise={new Promise((res) => setTimeout(() => res("root"), 10000))}
      />
      <Partial path={props.url.pathname} />
      <h1>Vite + RSC</h1>
      {/* <Partial path="/my-test" /> */}
      {/* Navigation to test RSC routing */}
      <div className="navigation-links">
        <h3>RSC Route Testing:</h3>
        <a href="/my-test" className="nav-button">
          Go to /my-test →
        </a>
      </div>
      {/* Dynamic RSC Content Loader */}
      <div className="card">
        <DynamicRscLoader />
      </div>

      <div className="card">
        <ClientCounter />
      </div>

      <div className="card">
        <ServerCounterClient>
          Server Counter: {getServerCounter()}
        </ServerCounterClient>
      </div>
      <div className="card">Request URL: {props.url?.href}</div>
      <ul className="read-the-docs">
        <li>
          Edit <code>src/client.tsx</code> to test client HMR.
        </li>
        <li>
          Edit <code>src/root.tsx</code> to test server HMR.
        </li>
        <li>
          Visit{" "}
          <a href="?__rsc" target="_blank">
            <code>?__rsc</code>
          </a>{" "}
          to view RSC stream payload.
        </li>
        <li>
          Visit{" "}
          <a href="?__nojs" target="_blank">
            <code>?__nojs</code>
          </a>{" "}
          to test server action without js enabled.
        </li>
      </ul>
    </div>
  );
}
