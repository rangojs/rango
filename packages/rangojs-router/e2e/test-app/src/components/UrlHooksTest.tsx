"use client";

import {
  useParams,
  usePathname,
  useSearchParams,
  useRouter,
} from "@rangojs/router/client";

/**
 * Test component for useParams, usePathname, and useSearchParams hooks.
 * Renders all hook values via data-testid attributes for e2e testing.
 */
export function UrlHooksTest() {
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  return (
    <div data-testid="url-hooks-test">
      <h2>URL Hooks Test</h2>

      {/* useParams output */}
      <div data-testid="params-section">
        <span data-testid="params-output">params:{JSON.stringify(params)}</span>
        <span data-testid="params-slug">slug:{params.slug ?? "none"}</span>
        <span data-testid="params-id">id:{params.id ?? "none"}</span>
      </div>

      {/* usePathname output */}
      <div data-testid="pathname-section">
        <span data-testid="pathname-output">pathname:{pathname}</span>
      </div>

      {/* useSearchParams output */}
      <div data-testid="search-section">
        <span data-testid="search-output">
          search:{searchParams.toString()}
        </span>
        <span data-testid="search-q">q:{searchParams.get("q") ?? "none"}</span>
        <span data-testid="search-page">
          page:{searchParams.get("page") ?? "none"}
        </span>
      </div>

      {/* Navigation buttons for testing updates */}
      <button
        data-testid="push-slug-world"
        onClick={() => router.push("/hook-tests/url-hooks/world")}
      >
        Push /world
      </button>

      <button
        data-testid="push-nested"
        onClick={() => router.push("/hook-tests/url-hooks/hello/42")}
      >
        Push /hello/42
      </button>

      <button
        data-testid="push-with-search"
        onClick={() => router.push("/hook-tests/url-hooks/test?q=react&page=2")}
      >
        Push with search
      </button>

      <button
        data-testid="push-no-params"
        onClick={() => router.push("/hook-tests")}
      >
        Push to no-params route
      </button>

      <button
        data-testid="replace-slug-replaced"
        onClick={() => router.replace("/hook-tests/url-hooks/replaced")}
      >
        Replace /replaced
      </button>

      <button data-testid="go-back" onClick={() => router.back()}>
        Back
      </button>

      <button data-testid="go-forward" onClick={() => router.forward()}>
        Forward
      </button>
    </div>
  );
}

/**
 * Selector test: useParams with selector for performance.
 */
export function UseParamsSelectorTest() {
  const slug = useParams((p) => p.slug);

  return (
    <span data-testid="params-selector-slug">
      selector-slug:{slug ?? "none"}
    </span>
  );
}
