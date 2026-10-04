"use client";

import {
  clientUrls,
  Link,
  useFetchLoader,
  useLoader,
} from "@rangojs/router/client";
import {
  ClientUrlsVarsFetchBareLoader,
  ClientUrlsVarsFetchMwLoader,
  ClientUrlsVarsLoader,
} from "./client-urls-vars.loader.js";

function ClientUrlsVarsProbe() {
  const { data } = useLoader(ClientUrlsVarsLoader);
  const bare = useFetchLoader(ClientUrlsVarsFetchBareLoader);
  const withMw = useFetchLoader(ClientUrlsVarsFetchMwLoader);

  return (
    <div data-testid="cu-vars">
      <div data-testid="cu-vars-route">{data}</div>
      <div data-testid="cu-vars-fetch-bare">{bare.data ?? "none"}</div>
      <div data-testid="cu-vars-fetch-mw">{withMw.data ?? "none"}</div>
      <button
        type="button"
        data-testid="cu-vars-fetch-bare-btn"
        onClick={() => void bare.load({})}
      >
        Fetch bare
      </button>
      <button
        type="button"
        data-testid="cu-vars-fetch-mw-btn"
        onClick={() => void withMw.load({})}
      >
        Fetch with middleware
      </button>
      <Link
        to="/client-urls-vars/other"
        prefetch="none"
        data-testid="cu-vars-other-link"
      >
        Other
      </Link>
    </div>
  );
}

function ClientUrlsVarsOther() {
  const { data } = useLoader(ClientUrlsVarsLoader);
  return (
    <div data-testid="cu-vars-other">
      <div data-testid="cu-vars-other-route">{data}</div>
      <Link
        to="/client-urls-vars"
        prefetch="none"
        data-testid="cu-vars-index-link"
      >
        Index
      </Link>
    </div>
  );
}

export default clientUrls(({ path, loader }) => [
  path("/", ClientUrlsVarsProbe, () => [loader(ClientUrlsVarsLoader)]),
  path("/other", ClientUrlsVarsOther, () => [loader(ClientUrlsVarsLoader)]),
]);
