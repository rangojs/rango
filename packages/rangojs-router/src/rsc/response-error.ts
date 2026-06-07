/**
 * Problem Details (RFC 9457) Builder
 *
 * Builds a problem+json error body from a caught error, controlling what
 * information is exposed based on error type and environment.
 */

import { RouterError } from "../errors.js";
import type { ProblemDetails } from "../urls.js";

/**
 * HTTP reason phrases for the problem `title` member. Inlined because the
 * router targets edge/worker runtimes without node's `http.STATUS_CODES`;
 * covers the full standard 4xx/5xx range, with a generic fallback for any
 * non-standard status a handler might set.
 */
const STATUS_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

function statusPhrase(status: number): string {
  return STATUS_PHRASES[status] ?? "Error";
}

/**
 * Build an RFC 9457 problem+json body from a caught error.
 * RouterError messages/codes are always exposed (developer-crafted).
 * Standard Error messages are hidden in production.
 *
 * The `type` member is omitted in this phase: per RFC 9457 an absent `type` is
 * treated as `"about:blank"` (no semantics beyond the HTTP status), so emitting
 * it adds nothing. Per-route problem-type URIs arrive with the declared-errors
 * map later. `code` is always present so consumers can branch on it
 * (`"INTERNAL"` for non-RouterError failures).
 */
export function createProblemDetails(
  error: unknown,
  status: number,
  isDev: boolean,
): ProblemDetails {
  if (error instanceof RouterError) {
    return {
      title: statusPhrase(status),
      status,
      detail: error.message,
      code: error.code,
      ...(isDev && error.stack ? { stack: error.stack } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      title: statusPhrase(status),
      status,
      detail: isDev ? error.message : "Internal Server Error",
      code: "INTERNAL",
      ...(isDev && error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    title: statusPhrase(status),
    status,
    detail: isDev ? String(error) : "Internal Server Error",
    code: "INTERNAL",
  };
}
