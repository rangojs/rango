/**
 * A bake-lane loader container holding React elements, through real Flight
 * (issue #942). Shared by loader-container-jsx.rsc-test.ts (production React)
 * and loader-container-jsx-dev.rsc-test.ts (development React).
 *
 * Runs the capture pipeline's steps in order: the mask resolveLoaderData
 * applies (loader-cache.ts), the capture render's Flight encode of the masked
 * container, the elide + pin encode of the drain (serializeResult, as
 * shell-capture.ts calls it), the HIT decode (deserializeResult) and the
 * overlay + Flight encode of the HIT payload. The importing test files mock
 * `@vitejs/plugin-rsc/rsc/{server,client}` with the testing stub, which runs
 * the vendored Flight builds with plugin-rsc's manifests.
 *
 * Elements are built with createElement, not JSX: with development NODE_ENV
 * this worker resolves `react/jsx-runtime` without the react-server condition
 * (see the vitest.rsc.config.ts header). Both go through React's
 * ReactElement, so the element shape is the one JSX produces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createElement,
  isValidElement,
  Suspense,
  type ReactElement,
  type ReactNode,
} from "react";
import { registerClientReference } from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import { renderToReadableStream } from "../../../deps/rsc.js";
import {
  deserializeResult,
  serializeResult,
} from "../../../cache/segment-codec.js";
import {
  elideLoaderContainer,
  isLoaderHoleMarker,
  maskNestedContainerThenables,
  overlayLoaderContainer,
} from "../loader-snapshot.js";
import type { MaskReport } from "../mask-nested.js";

type ElementWithDevFields = ReactElement<Record<string, unknown>> & {
  _debugStack?: unknown;
  _debugTask?: unknown;
};

const DEV_PROPERTIES_ERROR = "without development properties";

/** serializeResult, failing the test on any Flight error. */
async function encode(model: unknown): Promise<string> {
  const errors: unknown[] = [];
  const text = await serializeResult(model, (error) => {
    errors.push(error);
  });
  expect(errors).toEqual([]);
  expect(text).not.toBeNull();
  return text!;
}

/**
 * Encode a model that holds a never-settling (masked) promise: read until the
 * root row, the way the capture's prerender freezes the prelude with the hole
 * still pending, then cancel.
 */
async function encodeShell(model: unknown): Promise<string> {
  const errors: unknown[] = [];
  const reader = renderToReadableStream(model, {
    onError: (error: unknown) => {
      errors.push(error);
    },
  }).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!/(^|\n)0:/.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const renderErrors = [...errors];
  await reader.cancel();
  expect(renderErrors).toEqual([]);
  return text;
}

export function defineLoaderContainerJsxSuite(
  mode: "development" | "production",
): void {
  describe(`bake-lane loader container with React elements (${mode} React)`, () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      const devPropertyErrors = consoleError.mock.calls.filter(
        (args: unknown[]) => String(args[0]).includes(DEV_PROPERTIES_ERROR),
      );
      consoleError.mockRestore();
      expect(devPropertyErrors).toEqual([]);
    });

    it(`runs React ${mode}`, () => {
      const element = createElement("p") as ElementWithDevFields;
      // Dev elements carry non-enumerable _debugStack/_debugTask; a copy
      // made key by key drops them.
      expect(element._debugStack !== undefined).toBe(mode === "development");
    });

    it("an element without promises is shell material: mask, pin and HIT keep it intact", async () => {
      async function Related({ id }: { id: string }): Promise<ReactNode> {
        await Promise.resolve();
        return createElement("p", null, `related to ${id}`);
      }
      const related = createElement(
        "section",
        null,
        createElement("h2", null, "Related"),
        createElement(Related, { id: "1" }),
      );
      const container = { product: "p1", related };

      const masked = maskNestedContainerThenables(
        container,
      ) as typeof container;
      expect(await encode(masked)).toContain("related to 1");
      expect(masked.related).toBe(related);

      const elided = await elideLoaderContainer(masked);
      expect(elided).toMatchObject({ state: "ok", hasHole: false });
      if (elided.state !== "ok") return;
      expect((elided.value as typeof container).related).toBe(related);
      const pinned = await encode(elided.value);
      expect(pinned).toContain("related to 1");

      // Hole-free record: the HIT serves the pinned container.
      const recorded = await deserializeResult<typeof container>(pinned);
      const hit = overlayLoaderContainer(
        undefined,
        recorded,
      ) as typeof container;
      expect(hit.related).toBe(recorded.related);
      expect(await encode(hit)).toContain("related to 1");
    });

    it("a promise inside a host element stays an exact hole: the HIT fills it from the fresh run and pins the element's other props", async () => {
      const captureReviews = Promise.resolve(
        "reviews of the capturing request",
      );
      const reviews = createElement(
        Suspense,
        { fallback: "loading reviews (capture)" },
        createElement("p", null, captureReviews as never),
      ) as ElementWithDevFields;
      const container = { product: "p1", reviews };

      const report: MaskReport = { thenable: false };
      const masked = maskNestedContainerThenables(
        container,
        undefined,
        report,
      ) as typeof container;
      expect(report.thenable).toBe(true);
      const maskedReviews = masked.reviews as ElementWithDevFields;
      expect(isValidElement(maskedReviews)).toBe(true);
      expect(maskedReviews).not.toBe(reviews);
      expect(maskedReviews.type).toBe(Suspense);
      expect(maskedReviews._debugStack).toBe(reviews._debugStack);
      expect(maskedReviews._debugTask).toBe(reviews._debugTask);
      const maskedChild = (maskedReviews.props.children as ElementWithDevFields)
        .props.children;
      expect(maskedChild).not.toBe(captureReviews);
      expect(typeof (maskedChild as PromiseLike<unknown>).then).toBe(
        "function",
      );
      // The raw container is untouched (handler-side consumption).
      expect(
        (reviews.props.children as ElementWithDevFields).props.children,
      ).toBe(captureReviews);

      const shell = await encodeShell(masked);
      expect(shell).toContain("loading reviews (capture)");
      expect(shell).not.toContain("reviews of the capturing request");

      const elided = await elideLoaderContainer(masked);
      expect(elided).toMatchObject({ state: "ok", hasHole: true });
      if (elided.state !== "ok") return;
      const recordedValue = elided.value as { reviews: ElementWithDevFields };
      expect(isValidElement(recordedValue.reviews)).toBe(true);
      expect(
        isLoaderHoleMarker(
          (recordedValue.reviews.props.children as ElementWithDevFields).props
            .children,
        ),
      ).toBe(true);
      const pinned = await encode(elided.value);
      expect(pinned).toContain("loading reviews (capture)");

      const recorded = await deserializeResult(pinned);
      const fresh = {
        product: "p1",
        reviews: createElement(
          Suspense,
          { fallback: "loading reviews (fresh run)" },
          createElement(
            "p",
            null,
            Promise.resolve("reviews of this request") as never,
          ),
        ),
      };
      const hit = overlayLoaderContainer(fresh, recorded) as typeof fresh;
      expect(isValidElement(hit.reviews)).toBe(true);
      expect(hit.reviews).not.toBe(fresh.reviews);
      const payload = await encode(hit);
      expect(payload).toContain("reviews of this request");
      expect(payload).toContain("loading reviews (capture)");
      expect(payload).not.toContain("loading reviews (fresh run)");
      expect(payload).not.toContain("reviews of the capturing request");
    });

    it("a promise inside a client component's props stays an exact hole; its other props come from the pin", async () => {
      const ClientReviews = registerClientReference(
        () => {
          throw new Error("client reference called on the server");
        },
        "test/client-reviews.tsx",
        "ClientReviews",
      );
      const container = {
        reviews: createElement(ClientReviews, {
          heading: "heading (capture)",
          data: Promise.resolve("reviews of the capturing request"),
        }),
      };

      const masked = maskNestedContainerThenables(container);
      const elided = await elideLoaderContainer(masked);
      expect(elided).toMatchObject({ state: "ok", hasHole: true });
      if (elided.state !== "ok") return;
      const recordedValue = elided.value as { reviews: ElementWithDevFields };
      expect(recordedValue.reviews.type).toBe(ClientReviews);
      expect(recordedValue.reviews.props.heading).toBe("heading (capture)");
      expect(isLoaderHoleMarker(recordedValue.reviews.props.data)).toBe(true);
      const pinned = await encode(elided.value);

      const recorded = await deserializeResult(pinned);
      const fresh = {
        reviews: createElement(ClientReviews, {
          heading: "heading (fresh run)",
          data: Promise.resolve("reviews of this request"),
        }),
      };
      const hit = overlayLoaderContainer(fresh, recorded) as typeof fresh;
      const payload = await encode(hit);
      expect(payload).toContain("test/client-reviews.tsx");
      expect(payload).toContain("heading (capture)");
      expect(payload).not.toContain("heading (fresh run)");
      expect(payload).toContain("reviews of this request");
    });

    it('a client component decoded from Flight (a cache() or "use cache" read) keeps its non-promise props pinned', async () => {
      const ClientReviews = registerClientReference(
        () => {
          throw new Error("client reference called on the server");
        },
        "test/cached-client-reviews.tsx",
        "CachedClientReviews",
      );
      // loader-cache.ts serves a cache() hit through deserializeResult.
      const readThroughCache = async (heading: string, reviews: string) =>
        deserializeResult<{ reviews: ElementWithDevFields }>(
          await encode({
            reviews: createElement(ClientReviews, {
              heading,
              data: Promise.resolve(reviews),
            }),
          }),
        );
      const captured = await readThroughCache(
        "heading (capture)",
        "reviews of the capturing request",
      );
      // The decode hands the client component back as a lazy node type.
      expect((captured.reviews.type as { $$typeof?: unknown }).$$typeof).toBe(
        Symbol.for("react.lazy"),
      );

      const elided = await elideLoaderContainer(
        maskNestedContainerThenables(captured),
      );
      expect(elided).toMatchObject({ state: "ok", hasHole: true });
      if (elided.state !== "ok") return;
      const recordedValue = elided.value as { reviews: ElementWithDevFields };
      expect(isLoaderHoleMarker(recordedValue.reviews)).toBe(false);
      expect(isLoaderHoleMarker(recordedValue.reviews.props.data)).toBe(true);

      const recorded = await deserializeResult(await encode(elided.value));
      const fresh = await readThroughCache(
        "heading (fresh run)",
        "reviews of this request",
      );
      const payload = await encode(overlayLoaderContainer(fresh, recorded));
      expect(payload).toContain("heading (capture)");
      expect(payload).not.toContain("heading (fresh run)");
      expect(payload).toContain("reviews of this request");
    });

    it("a promise inside a server component's props makes the whole element the hole; the pin encode never renders it with a marker", async () => {
      const rendered: unknown[] = [];
      async function Reviews({
        data,
      }: {
        data: Promise<string>;
      }): Promise<ReactNode> {
        rendered.push(data);
        return createElement("p", null, await data);
      }
      const container = {
        product: "p1",
        reviews: createElement(
          "section",
          { className: "reviews" },
          createElement(Reviews, {
            data: Promise.resolve("reviews of the capturing request"),
          }),
        ),
      };

      const masked = maskNestedContainerThenables(container);
      const elided = await elideLoaderContainer(masked);
      expect(elided).toMatchObject({ state: "ok", hasHole: true });
      if (elided.state !== "ok") return;
      const section = (elided.value as { reviews: ElementWithDevFields })
        .reviews;
      expect(section.props.className).toBe("reviews");
      expect(isLoaderHoleMarker(section.props.children)).toBe(true);
      await encode(elided.value);
      expect(rendered).toEqual([]);

      const recorded = await deserializeResult(await encode(elided.value));
      const freshReviews = createElement(Reviews, {
        data: Promise.resolve("reviews of this request"),
      });
      const hit = overlayLoaderContainer(
        {
          product: "p1",
          reviews: createElement(
            "section",
            { className: "reviews" },
            freshReviews,
          ),
        },
        recorded,
      ) as { reviews: ElementWithDevFields };
      expect(hit.reviews.props.children).toBe(freshReviews);
      expect(await encode(hit)).toContain("reviews of this request");
    });
  });
}
