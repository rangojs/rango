/**
 * A teeResult stand-in for tests that mock segment-codec with a JSON codec:
 * it encodes through the mocked serializeResult and decodes the copy through
 * the mocked deserializeResult, so a test that overrides either one still
 * drives the "use cache" miss. A null encode rejects the copy, as a failed
 * stream does.
 */
export function teeThrough(
  serialize: (value: any, onError?: (error: unknown) => void) => unknown,
  deserialize: (encoded: string) => unknown,
): (
  value: unknown,
  onError?: (error: unknown) => void,
) => { decoded: Promise<unknown>; serialized: Promise<string | null> } {
  return (value, onError) => {
    const serialized = Promise.resolve(serialize(value, onError)) as Promise<
      string | null
    >;
    const decoded = serialized.then((text) => {
      if (text === null) throw new Error("encode failed");
      return deserialize(text);
    });
    decoded.catch(() => {});
    return { decoded, serialized };
  };
}
