import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RANGO_MCP_ENDPOINT } from "./protocol.js";
import { createRangoMcpServer, type RangoMcpToolHandlers } from "./server.js";

const MAX_BODY_BYTES = 1024 * 1024;

export type RangoMcpHttpMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

export interface RangoMcpHttpMiddlewareOptions {
  token: string;
  version: string;
  handlers: RangoMcpToolHandlers;
}

class RequestBodyTooLargeError extends Error {}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address.startsWith("::ffff:127.")
  );
}

function hasValidToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actualBuffer = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: message }));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new RequestBodyTooLargeError());
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new SyntaxError("Invalid JSON request body"));
      }
    });
    request.on("error", reject);
  });
}

export function createRangoMcpHttpMiddleware(
  options: RangoMcpHttpMiddlewareOptions,
): RangoMcpHttpMiddleware {
  return (request, response, next) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://rango.local").pathname;
    } catch {
      next();
      return;
    }
    if (pathname !== RANGO_MCP_ENDPOINT) {
      next();
      return;
    }

    void (async () => {
      if (!isLoopback(request.socket.remoteAddress)) {
        writeError(response, 403, "Forbidden");
        return;
      }
      if (request.headers.origin !== undefined) {
        writeError(response, 403, "Forbidden");
        return;
      }
      if (!hasValidToken(request.headers.authorization, options.token)) {
        writeError(response, 401, "Unauthorized");
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        writeError(response, 405, "Method Not Allowed");
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        writeError(response, 415, "Unsupported Media Type");
        return;
      }

      try {
        const body = await readJsonBody(request);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createRangoMcpServer(options.version, options.handlers);
        response.once("close", () => {
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        if (response.headersSent) return;
        if (error instanceof RequestBodyTooLargeError) {
          writeError(response, 413, "Payload Too Large");
        } else if (error instanceof SyntaxError) {
          writeError(response, 400, "Bad Request");
        } else {
          writeError(response, 500, "Internal Server Error");
        }
      }
    })();
  };
}
