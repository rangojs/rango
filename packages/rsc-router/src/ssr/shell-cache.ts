/**
 * Shell Cache Utilities
 *
 * Helper functions for capturing and streaming HTML shells.
 * The actual caching is handled by ShellCacheStore implementations.
 */

/**
 * Capture HTML stream to bytes (for caching).
 * Consumes the stream and returns the combined bytes.
 *
 * @param htmlStream - The HTML stream to capture
 * @returns Combined bytes from all chunks
 */
export async function captureHtmlBytes(
  htmlStream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = htmlStream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

/**
 * Create a ReadableStream from cached bytes.
 * Used to stream cached HTML shells.
 *
 * @param bytes - The cached bytes to stream
 * @returns A ReadableStream that emits the bytes
 */
export function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
