import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  FetchableTestLoader,
  HookTestLoader,
  HookTestLoaderB,
  UnregisteredLoader,
  ErrorLoader,
  ProtectedLoader,
  ComposingNonFetchableUsesNonFetchable,
  ComposingNonFetchableUsesFetchable,
  ComposingFetchableUsesFetchable,
  ComposingFetchableUsesNonFetchable,
} from "../loaders.js";
import { FetchLoaderTest } from "../components/FetchLoaderTest.js";
import {
  UseLoaderTest,
  UseFetchLoaderPreloadedTest,
  UseFetchLoaderUnregisteredTest,
  UseLoaderTestB,
  UseFetchLoaderTestB,
  ErrorLoaderTest,
  ProtectedLoaderTest,
  UnhandledErrorLoaderTest,
  UseLoaderThrowsTest,
  IsLoadingTest,
  ServerActionFormTest,
} from "../components/HookTests.js";
import {
  UseRouterTest,
  UseRouterTargetPage,
  UseNavigationStateOnlyTest,
} from "../components/UseRouterTest.js";
import {
  UrlHooksTest,
  UseParamsSelectorTest,
} from "../components/UrlHooksTest.js";

export const FetchLoaderHandler: Handler<"fetchLoader"> = () => (
  <div data-testid="fetch-loader-page">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="fetch-loader-title">useFetchLoader Test</h1>
    <p data-testid="fetch-loader-description">
      Test GET-based loader fetching with useFetchLoader hook
    </p>
    <FetchLoaderTest loader={FetchableTestLoader} />
  </div>
);

export const HookTestsIndexHandler: Handler<"hookTests.index"> = () => (
  <div data-testid="hook-tests-index">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="hook-tests-title">useLoader / useFetchLoader Tests</h1>
    <nav data-testid="hook-tests-nav">
      <Link to="/hook-tests/route-a" data-testid="hook-tests-route-a-link">
        Route A (Pre-loaded)
      </Link>
      <br />
      <Link to="/hook-tests/route-b" data-testid="hook-tests-route-b-link">
        Route B (For Navigation)
      </Link>
    </nav>
  </div>
);

export const HookTestsRouteAHandler: Handler<"hookTests.routeA"> = () => (
  <div data-testid="hook-tests-route-a">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <Link
      to="/hook-tests/route-b"
      data-testid="navigate-to-b-link"
      style={{ marginLeft: "1rem" }}
    >
      Navigate to Route B
    </Link>
    <h1 data-testid="route-a-title">Route A - Pre-loaded Loaders</h1>

    <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
      <UseLoaderTest loader={HookTestLoader} />
      <UseFetchLoaderPreloadedTest loader={HookTestLoader} />
      <UseFetchLoaderUnregisteredTest loader={UnregisteredLoader} />
    </div>

    <hr style={{ margin: "2rem 0" }} />
    <h2 data-testid="error-tests-title">Error Handling Tests</h2>
    <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
      <ErrorLoaderTest loader={ErrorLoader} />
      <UnhandledErrorLoaderTest loader={ErrorLoader} />
    </div>

    <hr style={{ margin: "2rem 0" }} />
    <h2 data-testid="middleware-tests-title">Middleware / Security Tests</h2>
    <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
      <ProtectedLoaderTest loader={ProtectedLoader} />
    </div>
  </div>
);

export const HookTestsRouteBHandler: Handler<"hookTests.routeB"> = () => (
  <div data-testid="hook-tests-route-b">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <Link
      to="/hook-tests/route-a"
      data-testid="navigate-to-a-link"
      style={{ marginLeft: "1rem" }}
    >
      Navigate to Route A
    </Link>
    <h1 data-testid="route-b-title">Route B - Navigation Target</h1>

    <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
      <UseLoaderTestB loader={HookTestLoaderB} />
      <UseFetchLoaderTestB loader={HookTestLoaderB} />
    </div>
  </div>
);

export const HookTestsNoLoaderHandler: Handler<"hookTests.noLoader"> = () => (
  <div data-testid="hook-tests-no-loader">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="no-loader-title">No Loader Route</h1>
    <p>This route does NOT have HookTestLoader registered via loader()</p>

    <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
      <UseLoaderThrowsTest loader={HookTestLoader} />
    </div>
  </div>
);

export const HookTestsFormActionHandler: Handler<
  "hookTests.formAction"
> = () => (
  <div data-testid="hook-tests-form-action">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="form-action-title">Form Action Test Route</h1>

    <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
      <IsLoadingTest loader={UnregisteredLoader} />
      <ServerActionFormTest />
    </div>
  </div>
);

export const LoaderCompositionHandler: Handler<"loaderComposition"> = async (
  ctx,
) => {
  // Load all four composition scenarios
  const nfUsesNf = await ctx.use(ComposingNonFetchableUsesNonFetchable);
  const nfUsesF = await ctx.use(ComposingNonFetchableUsesFetchable);
  const fUsesF = await ctx.use(ComposingFetchableUsesFetchable);
  const fUsesNf = await ctx.use(ComposingFetchableUsesNonFetchable);

  return (
    <div data-testid="loader-composition-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="page-title">Loader Composition Test</h1>

      <div
        data-testid="nf-uses-nf"
        data-composer={nfUsesNf.composerType}
        data-dependency={nfUsesNf.dependencyType}
      >
        <h2>Non-Fetchable uses Non-Fetchable</h2>
        <p data-testid="nf-uses-nf-base">Base value: {nfUsesNf.baseValue}</p>
        <p data-testid="nf-uses-nf-computed">Computed: {nfUsesNf.computed}</p>
        <p data-testid="nf-uses-nf-invocations">
          Invocations: {nfUsesNf.baseInvocationCount}
        </p>
      </div>

      <div
        data-testid="nf-uses-f"
        data-composer={nfUsesF.composerType}
        data-dependency={nfUsesF.dependencyType}
      >
        <h2>Non-Fetchable uses Fetchable</h2>
        <p data-testid="nf-uses-f-base">Base value: {nfUsesF.baseValue}</p>
        <p data-testid="nf-uses-f-computed">Computed: {nfUsesF.computed}</p>
        <p data-testid="nf-uses-f-invocations">
          Invocations: {nfUsesF.baseInvocationCount}
        </p>
      </div>

      <div
        data-testid="f-uses-f"
        data-composer={fUsesF.composerType}
        data-dependency={fUsesF.dependencyType}
      >
        <h2>Fetchable uses Fetchable</h2>
        <p data-testid="f-uses-f-base">Base value: {fUsesF.baseValue}</p>
        <p data-testid="f-uses-f-computed">Computed: {fUsesF.computed}</p>
        <p data-testid="f-uses-f-invocations">
          Invocations: {fUsesF.baseInvocationCount}
        </p>
      </div>

      <div
        data-testid="f-uses-nf"
        data-composer={fUsesNf.composerType}
        data-dependency={fUsesNf.dependencyType}
      >
        <h2>Fetchable uses Non-Fetchable</h2>
        <p data-testid="f-uses-nf-base">Base value: {fUsesNf.baseValue}</p>
        <p data-testid="f-uses-nf-computed">Computed: {fUsesNf.computed}</p>
        <p data-testid="f-uses-nf-invocations">
          Invocations: {fUsesNf.baseInvocationCount}
        </p>
      </div>
    </div>
  );
};

export const InlineActionHandler: Handler<"inlineAction"> = () => {
  // Inline action defined directly in the RSC component
  async function inlineTestAction(formData: FormData): Promise<void> {
    "use server";
    const value = formData.get("testValue") as string;
    // Process the action (return value not used when passed directly to form action)
    console.log({
      success: true,
      receivedValue: value,
      timestamp: new Date().toISOString(),
    });
  }

  return (
    <div data-testid="inline-action-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="inline-action-title">Inline Action Test</h1>
      <p data-testid="inline-action-description">
        Tests an action defined directly in the RSC (not imported from a "use
        server" module).
      </p>
      <form action={inlineTestAction} data-testid="inline-action-form">
        <input
          type="text"
          name="testValue"
          defaultValue="test-inline"
          data-testid="inline-action-input"
        />
        <button type="submit" data-testid="inline-action-submit">
          Submit Inline Action
        </button>
      </form>
    </div>
  );
};

export const ProgressiveEnhancementHandler: Handler<
  "progressiveEnhancement"
> = async () => {
  const { submitNameAction, getLastSubmittedName } =
    await import("../actions.js");
  const lastSubmitted = await getLastSubmittedName();

  return (
    <div data-testid="progressive-enhancement-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="page-title">Progressive Enhancement Test</h1>
      <p data-testid="page-description">
        This form should work without JavaScript enabled.
      </p>

      <form action={submitNameAction} method="post" data-testid="pe-form">
        <label htmlFor="name">Name:</label>
        <input
          type="text"
          id="name"
          name="name"
          defaultValue="test-name"
          data-testid="pe-input"
        />
        <button type="submit" data-testid="pe-submit">
          Submit
        </button>
      </form>

      {lastSubmitted && (
        <div data-testid="pe-result">
          <p>
            Last submitted name:{" "}
            <span data-testid="pe-result-name">{lastSubmitted}</span>
          </p>
        </div>
      )}
    </div>
  );
};

export const PeRedirectHandler: Handler<"peRedirect"> = async () => {
  const { peReturnRedirect, peThrowRedirect } = await import("../actions.js");

  return (
    <div data-testid="pe-redirect-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="pe-redirect-title">PE Redirect Test</h1>

      <form
        action={peReturnRedirect}
        method="post"
        data-testid="pe-return-redirect-form"
      >
        <button type="submit" data-testid="pe-return-redirect-btn">
          Return redirect
        </button>
      </form>

      <form
        action={peThrowRedirect}
        method="post"
        data-testid="pe-throw-redirect-form"
      >
        <button type="submit" data-testid="pe-throw-redirect-btn">
          Throw redirect
        </button>
      </form>
    </div>
  );
};

// ==================== useRouter test handlers ====================

export const UseRouterHandler: Handler<"hookTests.useRouter"> = () => (
  <div data-testid="use-router-page">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <h1 data-testid="use-router-title">useRouter Hook Tests</h1>

    <UseRouterTest loader={HookTestLoader} />

    <hr style={{ margin: "2rem 0" }} />
    <h2>useNavigation State-Only Test</h2>
    <UseNavigationStateOnlyTest />
  </div>
);

export const UseRouterTargetAHandler: Handler<
  "hookTests.useRouterTargetA"
> = () => (
  <div data-testid="use-router-target-a-page">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <Link
      to="/hook-tests/use-router"
      data-testid="back-to-router-link"
      style={{ marginLeft: "1rem" }}
    >
      Back to useRouter
    </Link>
    <h1 data-testid="target-a-title">Target A</h1>
    <UseRouterTargetPage targetId="a" loader={HookTestLoader} />
  </div>
);

export const UseRouterTargetBHandler: Handler<
  "hookTests.useRouterTargetB"
> = () => (
  <div data-testid="use-router-target-b-page">
    <Link to="/" data-testid="back-link">
      ← Back to Home
    </Link>
    <Link
      to="/hook-tests/use-router"
      data-testid="back-to-router-link"
      style={{ marginLeft: "1rem" }}
    >
      Back to useRouter
    </Link>
    <h1 data-testid="target-b-title">Target B</h1>
    <UseRouterTargetPage targetId="b" loader={HookTestLoaderB} />
  </div>
);

// ==================== URL hooks test handlers ====================

export const UrlHooksHandler: Handler<"hookTests.urlHooks"> = () => (
  <div data-testid="url-hooks-page">
    <h1 data-testid="url-hooks-title">URL Hooks Tests</h1>
    <UrlHooksTest />
    <UseParamsSelectorTest />
  </div>
);

export const UrlHooksNestedHandler: Handler<
  "hookTests.urlHooksNested"
> = () => (
  <div data-testid="url-hooks-nested-page">
    <h1 data-testid="url-hooks-nested-title">URL Hooks Nested</h1>
    <UrlHooksTest />
    <UseParamsSelectorTest />
  </div>
);
