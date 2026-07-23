import { bench, describe } from "vitest";
import { createResponseWithMergedHeaders } from "../helpers.js";
import { renderRscResponse } from "../render-pipeline.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscRenderInput } from "../render-pipeline.js";
import type { RscPayload } from "../types.js";

interface LegacyPayloadStage {
  type: "payload";
  payload: RscPayload;
  init: ResponseInit;
}

interface LegacyFlightStage {
  type: "flight";
  payload: RscPayload;
  stream: ReadableStream<Uint8Array>;
  init: ResponseInit;
}

interface LegacyStageControl {
  payload?: RscPayload;
  body?: BodyInit | null;
  init?: ResponseInit;
}

type LegacyRenderStage = LegacyPayloadStage | LegacyFlightStage;

const request = new Request("http://localhost/benchmark");
const url = new URL(request.url);
const payload: RscPayload = {
  metadata: { pathname: url.pathname, segments: [] },
};
const init: ResponseInit = {
  status: 202,
  headers: { "x-benchmark": "render-pipeline" },
};
const htmlInit: ResponseInit = {
  status: 203,
  headers: { "content-type": "text/html;charset=utf-8" },
};
const htmlBody = "<!doctype html><p>benchmark</p>";

const renderToReadableStream: HandlerContext["renderToReadableStream"] = () =>
  new ReadableStream<Uint8Array>();
const callOnError: HandlerContext["callOnError"] = () => {};

const input: RscRenderInput<unknown> = {
  ctx: { renderToReadableStream, callOnError },
  request,
  url,
  env: undefined,
  payload,
  init,
  recordSerializeMetric: false,
};

function directFlightResponse(): Response {
  const stream = renderToReadableStream(payload, {
    onError: (error: unknown) => {
      callOnError(error, "rendering", { request, url, env: undefined });
    },
  });
  return createResponseWithMergedHeaders(stream, init);
}

async function* legacyRenderStages(): AsyncGenerator<
  LegacyRenderStage,
  Response,
  LegacyStageControl | undefined
> {
  const payloadControl = yield { type: "payload", payload, init };
  const nextPayload = payloadControl?.payload ?? payload;
  const nextInit = payloadControl?.init ?? init;
  const stream = renderToReadableStream(nextPayload, {
    onError: (error: unknown) => {
      callOnError(error, "rendering", { request, url, env: undefined });
    },
  });
  const flightControl = yield {
    type: "flight",
    payload: nextPayload,
    stream,
    init: nextInit,
  };
  return createResponseWithMergedHeaders(
    flightControl?.body ?? stream,
    flightControl?.init ? { ...nextInit, ...flightControl.init } : nextInit,
  );
}

async function legacyFlightResponse(): Promise<Response> {
  const stages = legacyRenderStages();
  for (;;) {
    const step = await stages.next();
    if (step.done) return step.value;
  }
}

function immediatelyResolvedHtmlRender(
  _flight: ReadableStream<Uint8Array>,
): Promise<BodyInit> {
  return Promise.resolve(htmlBody);
}

async function directHtmlResponse(): Promise<Response> {
  const flight = renderToReadableStream(payload, {
    onError: (error: unknown) => {
      callOnError(error, "rendering", { request, url, env: undefined });
    },
  });
  const body = await immediatelyResolvedHtmlRender(flight);
  return createResponseWithMergedHeaders(body, { ...init, ...htmlInit });
}

async function legacyHtmlResponse(): Promise<Response> {
  const stages = legacyRenderStages();
  const payloadStep = await stages.next();
  if (payloadStep.done || payloadStep.value.type !== "payload") {
    throw new Error("legacy benchmark skipped payload stage");
  }
  const flightStep = await stages.next();
  if (flightStep.done || flightStep.value.type !== "flight") {
    throw new Error("legacy benchmark skipped Flight stage");
  }
  const body = await immediatelyResolvedHtmlRender(flightStep.value.stream);
  const responseStep = await stages.next({ body, init: htmlInit });
  if (!responseStep.done) {
    throw new Error("legacy benchmark did not finish after HTML");
  }
  return responseStep.value;
}

describe("RSC render pipeline: Flight response", () => {
  bench("direct Flight + Response baseline", () => {
    directFlightResponse();
  });

  bench("legacy async-generator payload -> Flight -> response", async () => {
    await legacyFlightResponse();
  });

  bench("renderRscResponse Flight-only", async () => {
    await renderRscResponse(input);
  });
});

describe("RSC render pipeline: immediately resolved HTML", () => {
  bench("direct Flight + HTML + Response baseline", async () => {
    await directHtmlResponse();
  });

  bench("legacy async-generator Flight + external HTML", async () => {
    await legacyHtmlResponse();
  });

  bench("renderRscResponse Flight + HTML", async () => {
    await renderRscResponse(input, {
      html: (flight) => ({
        render: () => immediatelyResolvedHtmlRender(flight.stream),
        init: htmlInit,
      }),
    });
  });
});
