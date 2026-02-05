import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { SlowLoader } from "../loaders.js";
import { Breadcrumbs } from "../handles.js";
import { RefTestLoaderProp } from "../components/RefTestLoaderProp.js";
import { RefTestHandleProp } from "../components/RefTestHandleProp.js";

/**
 * Ref serialization test routes.
 * Tests passing loader and handle refs as props to client components.
 * The RSC Flight protocol uses toJSON to serialize these refs.
 */
export const refTestPatterns = urls(({ path, loader, loading }) => [
  // Loader ref passed as prop to client component
  path(
    "/loader-prop",
    () => <RefTestLoaderProp loader={SlowLoader} />,
    { name: "loaderProp" },
    () => [
      loader(SlowLoader),
      loading(
        <div data-testid="ref-test-loader-loading">
          <p>Loading loader ref test...</p>
        </div>,
      ),
    ],
  ),

  // Handle ref passed as prop to client component
  path(
    "/handle-prop",
    (ctx) => {
      const push = ctx.use(Breadcrumbs);
      push({ label: "Home", href: "/" });
      push({ label: "Ref Test", href: "/ref-test/handle-prop" });
      return <RefTestHandleProp handle={Breadcrumbs} />;
    },
    { name: "handleProp" },
  ),

  // Both loader + handle refs passed as props
  path(
    "/both-props",
    (ctx) => {
      const push = ctx.use(Breadcrumbs);
      push({ label: "Home", href: "/" });
      push({ label: "Both Props", href: "/ref-test/both-props" });
      return (
        <div data-testid="ref-test-both-page">
          <Link to="/" data-testid="back-link">
            &larr; Back to Home
          </Link>
          <h1 data-testid="ref-test-both-title">Both Refs as Props</h1>
          <RefTestLoaderProp loader={SlowLoader} />
          <RefTestHandleProp handle={Breadcrumbs} />
        </div>
      );
    },
    { name: "bothProps" },
    () => [
      loader(SlowLoader),
      loading(
        <div data-testid="ref-test-both-loading">
          <p>Loading both refs test...</p>
        </div>,
      ),
    ],
  ),
]);
