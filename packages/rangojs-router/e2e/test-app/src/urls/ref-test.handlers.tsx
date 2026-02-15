import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { SlowLoader } from "../loaders.js";
import { Breadcrumbs } from "../handles.js";
import { RefTestLoaderProp } from "../components/RefTestLoaderProp.js";
import { RefTestHandleProp } from "../components/RefTestHandleProp.js";

export const RefTestLoaderPropHandler: Handler<"refTest.loaderProp"> = () => (
  <RefTestLoaderProp loader={SlowLoader} />
);

export const RefTestHandlePropHandler: Handler<"refTest.handleProp"> = (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Home", href: "/" });
  push({ label: "Ref Test", href: "/ref-test/handle-prop" });
  return <RefTestHandleProp handle={Breadcrumbs} />;
};

export const RefTestBothPropsHandler: Handler<"refTest.bothProps"> = (ctx) => {
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
};
