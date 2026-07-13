import type { Handler } from "@rangojs/router";
import { cookies, createLoader, Meta } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { PeHeaderProbeLoader } from "../loaders.js";
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
  InlineBoundActionForm,
  type InlineBoundPageHoleData,
  type InlineBoundResult,
} from "../components/InlineBoundActionForm.js";
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

const INLINE_BOUND_WARM_HOLE_DELAY_MS = 2_000;
const INLINE_BOUND_PAGE_HOLE_FAILSAFE_MS = 30_000;
const INLINE_BOUND_PAGE_HOLE_AFTER_ACTION_MS = 2_000;
const INLINE_BOUND_ACTION_DELAY_MS = 1_000;
const INLINE_BOUND_ACTION_STREAM_DELAY_MS = 1_200;

// Probe-scoped resolvers make the ordering causal: the page hole cannot finish
// until this page's action result has streamed. The long timer is only a leak
// failsafe; API warm-up requests opt into the short timer via a test header.
const inlineBoundPageHoleResolvers = new Map<string, Set<() => void>>();

function createInlineBoundPageHole(
  probe: string,
  shortWarmup: boolean,
): Promise<string> {
  return new Promise((resolve) => {
    const resolvers = inlineBoundPageHoleResolvers.get(probe) ?? new Set();
    inlineBoundPageHoleResolvers.set(probe, resolvers);
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timeout);
      resolvers.delete(finish);
      if (resolvers.size === 0) inlineBoundPageHoleResolvers.delete(probe);
      resolve("Page hole resolved");
    };
    resolvers.add(finish);
    timeout = setTimeout(
      finish,
      shortWarmup
        ? INLINE_BOUND_WARM_HOLE_DELAY_MS
        : INLINE_BOUND_PAGE_HOLE_FAILSAFE_MS,
    );
  });
}

function resolveInlineBoundPageHoleAfterAction(probe: string): void {
  setTimeout(() => {
    for (const resolve of [
      ...(inlineBoundPageHoleResolvers.get(probe) ?? []),
    ]) {
      resolve();
    }
  }, INLINE_BOUND_PAGE_HOLE_AFTER_ACTION_MS);
}

export const InlineBoundPageHoleLoader = createLoader(
  async (ctx): Promise<InlineBoundPageHoleData> => ({
    pendingData: createInlineBoundPageHole(
      ctx.searchParams.get("probe") ?? "default",
      ctx.request.headers.has("x-rango-test-short-inline-hole"),
    ),
  }),
);

export const InlineBoundActionHandler: Handler<"inlineBoundAction"> = (ctx) => {
  // Render-scope value computed on the server. The inline action below closes
  // over it, so plugin-rsc treats it as a bound argument (encrypted in
  // production via encryptActionBoundArgs / decrypted via
  // decryptActionBoundArgs). The client can never see or reconstruct this
  // value, so a correct round-trip proves bound-arg serialization works.
  const captured = `server-token-${Date.now().toString(36)}`;
  const probe = ctx.searchParams.get("probe") ?? "default";

  async function inlineBoundAction(
    _prev: { captured: string; submitted: string } | null,
    formData: FormData,
  ): Promise<InlineBoundResult> {
    "use server";
    const submitted = String(formData.get("submitted") ?? "");
    await new Promise((resolve) =>
      setTimeout(resolve, INLINE_BOUND_ACTION_DELAY_MS),
    );
    return {
      captured,
      submitted,
      streamed: new Promise((resolve) =>
        setTimeout(() => {
          resolve(`completed:${captured}:${submitted}`);
          resolveInlineBoundPageHoleAfterAction(probe);
        }, INLINE_BOUND_ACTION_STREAM_DELAY_MS),
      ),
    };
  }

  return (
    <div data-testid="inline-bound-action-page">
      <Link to="/" data-testid="back-link">
        Back to Home
      </Link>
      <h1 data-testid="inline-bound-action-title">Inline Bound Action Test</h1>
      <p data-testid="inline-bound-action-rendered-captured">
        rendered:{captured}
      </p>
      <InlineBoundActionForm
        boundAction={inlineBoundAction}
        pageHoleLoader={InlineBoundPageHoleLoader}
      />
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

/**
 * Submit-parity fixture for the consumer e2e harness
 * (@rangojs/router/testing/e2e expectParity({ submit })). The form posts an
 * `amount` to parityCounterAction, which reads/increments/writes the
 * `parity-count` cookie. The handler renders that cookie into
 * `parity-counter-value`. State is cookie-scoped, so the JS context and the
 * fresh no-JS context each start at 0 and reach the same value after their own
 * submit — satisfying the harness's double-execution requirement. With JS the
 * router enhances the submit in place; without JS the browser performs a native
 * POST the action handles, then re-renders the count.
 */
export const ParityCounterHandler: Handler<"parityCounter"> = async () => {
  const { parityCounterAction } = await import("../actions.js");
  const count = parseInt(cookies().get("parity-count")?.value ?? "0", 10);

  return (
    <div data-testid="parity-counter-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="page-title">Parity Counter</h1>
      <p>
        Count: <span data-testid="parity-counter-value">{count}</span>
      </p>

      <form action={parityCounterAction} data-testid="parity-counter-form">
        <label htmlFor="amount">Amount:</label>
        <input
          type="text"
          id="amount"
          name="amount"
          defaultValue="1"
          data-testid="parity-counter-amount"
        />
        <button type="submit" data-testid="parity-counter-submit">
          Add
        </button>
      </form>
    </div>
  );
};

export const PeRedirectHandler: Handler<"peRedirect"> = async () => {
  const {
    peReturnRedirect,
    peThrowRedirect,
    peExternalRedirectBlocked,
    peExternalRedirectAllowed,
  } = await import("../actions.js");

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

      <form
        action={peExternalRedirectBlocked}
        method="post"
        data-testid="pe-external-redirect-form"
      >
        <button type="submit" data-testid="pe-external-redirect-btn">
          Cross-origin redirect (must be blocked)
        </button>
      </form>

      <form
        action={peExternalRedirectAllowed}
        method="post"
        data-testid="pe-external-allowed-form"
      >
        <button type="submit" data-testid="pe-external-allowed-btn">
          Cross-origin redirect with external:true (must be allowed)
        </button>
      </form>
    </div>
  );
};

// The literal payload an attacker would put in a JSON-LD string field to break
// out of <script type="application/ld+json">. MetaTags.escapeJsonForScript must
// neutralize the "<"/">"/"&" so this can never close the tag or execute.
export const META_ESCAPE_PAYLOAD = "</script><script>window.__pwned=1</script>";

/**
 * JSON-LD escaping fixture. Emits a script:ld+json descriptor whose
 * `description` field contains a literal `</script>` breakout attempt. The
 * MetaTags fix escapes the serialized JSON before dangerouslySetInnerHTML, so
 * the payload stays inside the script tag (no breakout, no execution) and the
 * JSON re-parses to the original string.
 */
export const MetaEscapeHandler: Handler<"metaEscape"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({
    "script:ld+json": {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Meta Escape Test",
      description: META_ESCAPE_PAYLOAD,
    },
  });

  return (
    <div data-testid="meta-escape-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="meta-escape-title">Meta Escape Test</h1>
    </div>
  );
};

/**
 * Progressive-enhancement header-preservation fixture. A "use server" form
 * action submits while a loader reads the `pe-probe` request cookie. Under a
 * no-JS submit the browser performs a native POST; the PE re-render must carry
 * the POST's request headers so the loader still sees the cookie. The page
 * echoes the loader-read cookie and whether the action's marker cookie is set.
 */
export const PeHeaderHandler: Handler<"peHeader"> = async (ctx) => {
  const { peHeaderSubmitAction } = await import("../actions.js");
  const { cookieProbe, customHeader, submitted } =
    await ctx.use(PeHeaderProbeLoader);

  return (
    <div data-testid="pe-header-page">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="pe-header-title">PE Header Preservation Test</h1>
      <p data-testid="pe-header-probe">{cookieProbe ?? "no-probe"}</p>
      <p data-testid="pe-header-custom">{customHeader ?? "no-custom"}</p>
      <p data-testid="pe-header-submitted">{submitted ? "yes" : "no"}</p>

      {/* No method/encType: React manages those for a function action and
          warns (and produces a hydration attribute mismatch) if we set them. */}
      <form action={peHeaderSubmitAction} data-testid="pe-header-form">
        <input
          type="text"
          name="note"
          defaultValue="hello"
          data-testid="pe-header-note"
        />
        <button type="submit" data-testid="pe-header-submit">
          Submit
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
