import { urls } from "@rangojs/router";
import { SlowLoader } from "../loaders.js";
import {
  RefTestLoaderPropHandler,
  RefTestHandlePropHandler,
  RefTestBothPropsHandler,
} from "./ref-test.handlers.js";

/**
 * Ref serialization test routes.
 * Tests passing loader and handle refs as props to client components.
 * The RSC Flight protocol uses toJSON to serialize these refs.
 */
export const refTestPatterns = urls(({ path, loader, loading }) => [
  path(
    "/loader-prop",
    RefTestLoaderPropHandler,
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

  path("/handle-prop", RefTestHandlePropHandler, { name: "handleProp" }),

  path(
    "/both-props",
    RefTestBothPropsHandler,
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
