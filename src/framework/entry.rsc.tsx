import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "@vitejs/plugin-rsc/rsc";
import type { ReactFormState } from "react-dom/client";
import { router } from "../routes.tsx";
import { Storage } from "./entry.storage.ts";
// The schema of payload which is serialized into RSC stream on rsc environment
// and deserialized on ssr/client environments.
export type RscPayload = {
  // this demo renders/serializes/deserizlies entire root html element
  // but this mechanism can be changed to render/fetch different parts of components
  // based on your own route conventions.
  root: React.ReactNode;
  // server action return value of non-progressive enhancement case
  returnValue?: unknown;
  // server action form state (e.g. useActionState) of progressive enhancement case
  formState?: ReactFormState;
  // Metadata for partial rendering
  metadata?: {
    pathname: string;
    startIndex?: number;
    preservedLayouts?: string[];
  };
};

// the plugin by default assumes `rsc` entry having default export of request handler.
// however, how server entries are executed can be customized by registering
// own server handler e.g. `@cloudflare/vite-plugin`.
export default async function handler(request: Request): Promise<Response> {
  const streams = [];

  return await Storage.run(streams, () => _handler(request));
}
async function _handler(request: Request): Promise<Response> {
  // handle server function request
  const isAction = request.method === "POST";
  let returnValue: unknown | undefined;
  let formState: ReactFormState | undefined;
  let temporaryReferences: unknown | undefined;
  if (isAction) {
    // x-rsc-action header exists when action is called via `ReactClient.setServerCallback`.
    const actionId = request.headers.get("x-rsc-action");
    if (actionId) {
      const contentType = request.headers.get("content-type");
      const body = contentType?.startsWith("multipart/form-data")
        ? await request.formData()
        : await request.text();
      temporaryReferences = createTemporaryReferenceSet();
      const args = await decodeReply(body, { temporaryReferences });
      const action = await loadServerAction(actionId);
      returnValue = await action.apply(null, args);
    } else {
      // otherwise server function is called via `<form action={...}>`
      // before hydration (e.g. when javascript is disabled).
      // aka progressive enhancement.
      const formData = await request.formData();
      const decodedAction = await decodeAction(formData);
      const result = await decodedAction();
      formState = await decodeFormState(result, formData);
    }
  }

  // serialization from React VDOM tree to RSC stream.
  // we render RSC stream after handling server function request
  // so that new render reflects updated state from server function call
  // to achieve single round trip to mutate and fetch from server.
  const url = new URL(request.url);

  // Check if this is a partial render request
  const isPartialRequest = url.searchParams.has("_rsc_partial");
  const previousPathname = url.searchParams.get("_rsc_prev");

  console.log(`\n[Entry.RSC] ==================== REQUEST ====================`);
  console.log(`[Entry.RSC] URL: ${url.pathname}${url.search}`);
  console.log(`[Entry.RSC] Method: ${request.method}`);
  console.log(`[Entry.RSC] Is partial: ${isPartialRequest}`);
  console.log(`[Entry.RSC] Previous path: ${previousPathname || 'N/A'}`);

  let component: React.ReactNode;
  let metadata: RscPayload["metadata"];

  if (isPartialRequest && previousPathname) {
    console.log(`[Entry.RSC] >>> Attempting PARTIAL render`);
    // Partial rendering - only render changed segments
    const partialResult = await router.matchPartial(request, previousPathname);
    if (partialResult) {
      component = partialResult.component;
      metadata = {
        pathname: url.pathname,
        startIndex: partialResult.startIndex,
        preservedLayouts: partialResult.preservedLayouts,
      };
      console.log(`[Entry.RSC] ✓ Partial render successful`);
      console.log(`[Entry.RSC]   Start index: ${partialResult.startIndex}`);
      console.log(`[Entry.RSC]   Preserved layouts:`, partialResult.preservedLayouts);
    } else {
      // Fallback to full render if partial match fails
      console.log(`[Entry.RSC] ⚠️ Partial render failed, falling back to full render`);
      component = await router.match(request);
      metadata = { pathname: url.pathname };
    }
  } else {
    // Full page render using the router
    console.log(`[Entry.RSC] >>> Performing FULL render`);
    component = await router.match(request);
    metadata = { pathname: url.pathname };
  }

  // Handle 404
  if (!component) {
    console.log(`[Entry.RSC] ❌ No component returned - showing 404`);
    component = (
      <html>
        <body>
          <h1>404 - Not Found</h1>
          <p>The page {url.pathname} was not found.</p>
          <a href="/">Go home</a>
        </body>
      </html>
    );
  } else {
    console.log(`[Entry.RSC] ✓ Component ready for rendering`);
    console.log(`[Entry.RSC]   Component type:`, component?.type?.name || typeof component);
  }

  const rscPayload: RscPayload = {
    root: component,
    formState,
    returnValue,
    metadata,
  };

  console.log(`[Entry.RSC] RSC Payload metadata:`, metadata);
  console.log(`[Entry.RSC] ==================== END REQUEST ====================\n`);
  const rscOptions = { temporaryReferences };
  const rscStream = renderToReadableStream<RscPayload>(rscPayload, rscOptions);

  // respond RSC stream without HTML rendering based on framework's convention.
  // here we use request header `content-type`.
  // additionally we allow `?__rsc` and `?__html` to easily view payload directly.
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

  // Delegate to SSR environment for html rendering.
  // The plugin provides `loadModule` helper to allow loading SSR environment entry module
  // in RSC environment. however this can be customized by implementing own runtime communication
  // e.g. `@cloudflare/vite-plugin`'s service binding.
  const ssrEntryModule = await import.meta.viteRsc.loadModule<
    typeof import("./entry.ssr.tsx")
  >("ssr", "index");
  const htmlStream = await ssrEntryModule.renderHTML(
    rscStream,
    {
      formState,
      // allow quick simulation of javscript disabled browser
      debugNojs: url.searchParams.has("__nojs"),
    },
    Storage.getStore()
  );

  // respond html
  return new Response(htmlStream, {
    headers: {
      "Content-type": "text/html",
      vary: "accept",
    },
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
