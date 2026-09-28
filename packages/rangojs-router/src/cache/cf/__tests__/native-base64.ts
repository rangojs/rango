/**
 * Install the TC39 `Uint8Array.fromBase64` / `Uint8Array.prototype.toBase64`
 * (workerd has them, Node 22/24 do not) for a test, backed by Buffer unless
 * stand-ins are passed. Returns a restore function that puts back the
 * original property descriptors, so a runtime that ships the real methods
 * keeps them after the test.
 */
export function installNativeBase64(
  fromBase64: (b64: string) => Uint8Array = (b64) =>
    new Uint8Array(Buffer.from(b64, "base64")),
  toBase64: (this: Uint8Array) => string = function (this: Uint8Array) {
    return Buffer.from(this).toString("base64");
  },
): () => void {
  const fromDescriptor = Object.getOwnPropertyDescriptor(
    Uint8Array,
    "fromBase64",
  );
  const toDescriptor = Object.getOwnPropertyDescriptor(
    Uint8Array.prototype,
    "toBase64",
  );
  Object.defineProperty(Uint8Array, "fromBase64", {
    value: fromBase64,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: toBase64,
    configurable: true,
    writable: true,
  });
  return () => {
    if (fromDescriptor) {
      Object.defineProperty(Uint8Array, "fromBase64", fromDescriptor);
    } else {
      delete (Uint8Array as unknown as Record<string, unknown>).fromBase64;
    }
    if (toDescriptor) {
      Object.defineProperty(Uint8Array.prototype, "toBase64", toDescriptor);
    } else {
      delete (Uint8Array.prototype as unknown as Record<string, unknown>)
        .toBase64;
    }
  };
}
