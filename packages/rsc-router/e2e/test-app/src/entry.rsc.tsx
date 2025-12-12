import {
  renderToReadableStream,
  decodeReply,
  createTemporaryReferenceSet,
  loadServerAction,
} from "@vitejs/plugin-rsc/rsc";
import { router } from "./router.js";
import {
  renderSegments,
  type ResolvedSegment,
  type SlotState,
} from "rsc-router/server";

export type RscPayload = {
  root: React.ReactNode;
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    isError?: boolean;
    matched?: string[];
    diff?: string[];
    slots?: Record<string, SlotState>;
  };
  returnValue?: { ok: boolean; data: any };
  formState?: any;
};

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const isPartial = url.searchParams.has("_rsc_partial");
  const isAction =
    request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
  const actionId =
    request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

  let payload: RscPayload;

  try {
    if (isAction && actionId) {
      const temporaryReferences = createTemporaryReferenceSet();

      const contentType = request.headers.get("content-type") || "";
      let args: any[] = [];
      let actionFormData: FormData | undefined;

      try {
        const body = contentType.includes("multipart/form-data")
          ? await request.formData()
          : await request.text();

        if (body instanceof FormData) {
          actionFormData = body;
        }

        if (
          (body instanceof FormData && body.entries().next().done === false) ||
          (typeof body === "string" && body.length > 0)
        ) {
          args = await decodeReply(body, { temporaryReferences });
        }
      } catch (error) {
        throw new Error(`Failed to decode action arguments: ${error}`);
      }

      let returnValue: { ok: boolean; data: any };
      let actionStatus = 200;

      try {
        const action = await loadServerAction(actionId);
        const data = await action.apply(null, args);
        returnValue = { ok: true, data };
      } catch (error) {
        returnValue = { ok: false, data: error };
        actionStatus = 500;
      }

      const actionName = actionId.includes("#")
        ? actionId.split("#").pop()!
        : actionId;

      const actionContext = {
        actionId: actionName,
        actionUrl: new URL(request.url),
        actionResult: returnValue.data,
        formData: actionFormData,
      };

      const matchResult = await router.matchPartial(request, {}, actionContext);

      if (!matchResult) {
        const fullMatch = await router.match(request, {});
        const root = renderSegments(fullMatch.segments);

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: fullMatch.segments,
            matched: fullMatch.matched,
            diff: fullMatch.diff,
          },
          returnValue,
        };

        const rscStream = renderToReadableStream<RscPayload>(payload, {
          temporaryReferences,
        });

        return new Response(rscStream, {
          status: actionStatus,
          headers: { "content-type": "text/x-component;charset=utf-8" },
        });
      }

      const root = renderSegments(matchResult.segments);

      payload = {
        root: null,
        metadata: {
          pathname: url.pathname,
          segments: matchResult.segments,
          isPartial: true,
          matched: matchResult.matched,
          diff: matchResult.diff,
          slots: matchResult.slots,
        },
        returnValue,
      };

      const rscStream = renderToReadableStream<RscPayload>(payload, {
        temporaryReferences,
      });

      return new Response(rscStream, {
        status: actionStatus,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      });
    }

    if (isPartial) {
      const result = await router.matchPartial(request, {});

      if (!result) {
        const match = await router.match(request, {});
        const root = renderSegments(match.segments);

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: match.segments,
            matched: match.matched,
            diff: match.diff,
            isPartial: false,
          },
        };
      } else {
        payload = {
          root: null,
          metadata: {
            pathname: url.pathname,
            segments: result.segments,
            matched: result.matched,
            diff: result.diff,
            isPartial: true,
            slots: result.slots,
          },
        };
      }
    } else {
      const match = await router.match(request, {});
      const root = renderSegments(match.segments);

      payload = {
        root,
        metadata: {
          pathname: url.pathname,
          segments: match.segments,
          matched: match.matched,
          diff: match.diff,
          isPartial: false,
        },
      };
    }

    const rscStream = renderToReadableStream<RscPayload>(payload);

    const isRscRequest =
      (!request.headers.get("accept")?.includes("text/html") &&
        !url.searchParams.has("__html")) ||
      url.searchParams.has("__rsc");

    if (isRscRequest) {
      return new Response(rscStream, {
        headers: {
          "content-type": "text/x-component;charset=utf-8",
          vary: "accept",
        },
      });
    }

    const ssrEntryModule = await import.meta.viteRsc.loadModule<
      typeof import("./entry.ssr.js")
    >("ssr", "index");

    const htmlStream = await ssrEntryModule.renderHTML(rscStream);

    return new Response(htmlStream, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error(`[RSC] Error:`, error);
    throw error;
  }
}
