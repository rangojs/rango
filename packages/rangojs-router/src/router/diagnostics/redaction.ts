const DEFAULT_TEXT_BYTES = 2_048;
const MAX_ERROR_NAME_BYTES = 128;
const MAX_ERROR_MESSAGE_BYTES = 2_048;

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      continue;
    }
    result += character;
  }
  return result;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (maxBytes <= 3) return ".".repeat(maxBytes);
  const characters: string[] = [];
  const characterSizes: number[] = [];
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const characterBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + characterBytes > maxBytes) {
      while (bytes > maxBytes - 3) {
        characters.pop();
        bytes -= characterSizes.pop()!;
      }
      return `${characters.join("")}...`;
    }
    characters.push(character);
    characterSizes.push(characterBytes);
    bytes += characterBytes;
  }
  return characters.join("");
}

function redactCredentialAssignment(
  match: string,
  _quote: string,
  key: string,
): string {
  return isDiagnosticCredentialKey(key) ? `${key}=[redacted]` : match;
}

export function isDiagnosticCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    normalized === "auth" ||
    normalized === "sid" ||
    /authorization|cookies?|setcookies?|jwt|(?:secret|token|password|passwd|credential|privatekey|accesskey|apikey|databaseurl|session|sessionid)$/.test(
      normalized,
    )
  );
}

export function sanitizeDiagnosticText(
  value: string,
  maxBytes: number = DEFAULT_TEXT_BYTES,
): string {
  const bounded = boundUtf8(value, maxBytes);
  return boundUtf8(
    stripControlCharacters(bounded)
      .replace(/([?&][^=\s&]+)=([^&\s]+)/g, "$1=[redacted]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*\.\.\.$/gi, "$1[redacted]...")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
      .replace(
        /\b((?:set[\s_-]*)?cookies?)\s*[:=]\s*[^\r\n]*/gi,
        "$1=[redacted]",
      )
      .replace(
        /\b(authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?\S+/gi,
        "$1=[redacted]",
      )
      .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(
        /\b(secret|token|password|passwd|credential|private[\s_-]?key|access[\s_-]?key|api[\s_-]?key|database[\s_-]?url|authorization|auth|session(?:[\s_-]?id)?|sid|jwt(?:[\s_-]?assertion)?)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
        "$1=[redacted]",
      )
      .replace(
        /(["']?)([a-z][a-z0-9_-]{0,127})\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
        redactCredentialAssignment,
      ),
    maxBytes,
  );
}

export interface SerializedDiagnosticError {
  name: string;
  message: string;
  stack: string | null;
}

export function serializeDiagnosticError(
  error: unknown,
): SerializedDiagnosticError {
  let name = "Error";
  let message = "Unknown error";
  let stack: string | null = null;
  try {
    if (typeof error === "string") {
      message = error;
    } else if (error && typeof error === "object") {
      const nameDescriptor = Object.getOwnPropertyDescriptor(error, "name");
      const messageDescriptor = Object.getOwnPropertyDescriptor(
        error,
        "message",
      );
      if (typeof nameDescriptor?.value === "string")
        name = nameDescriptor.value;
      if (typeof messageDescriptor?.value === "string") {
        message = messageDescriptor.value;
      }
      const stackDescriptor = Object.getOwnPropertyDescriptor(error, "stack");
      if (typeof stackDescriptor?.value === "string") {
        stack = stackDescriptor.value;
      } else if (error instanceof Error && typeof error.stack === "string") {
        // Node 24 exposes Error.stack as a lazy own accessor. Read it only after
        // establishing Error identity; arbitrary object accessors stay untouched.
        stack = error.stack;
      }
    }
  } catch {}
  if (stack) {
    try {
      const cwd = process.cwd();
      stack = sanitizeDiagnosticText(stack, 8_192).replaceAll(cwd, ".");
    } catch {
      stack = sanitizeDiagnosticText(stack, 8_192);
    }
  }
  return {
    name: sanitizeDiagnosticText(name, MAX_ERROR_NAME_BYTES),
    message: sanitizeDiagnosticText(message, MAX_ERROR_MESSAGE_BYTES),
    stack,
  };
}

export function diagnosticSearchNames(url: URL): string[] {
  return [...new Set(url.searchParams.keys())]
    .slice(0, 64)
    .map((name) => sanitizeDiagnosticText(name, 256));
}
