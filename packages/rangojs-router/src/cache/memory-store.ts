/**
 * In-Memory Cache Store
 *
 * Simple implementation for development and testing.
 * Not suitable for production (no persistence, single-instance only).
 *
 * @internal This is reserved for future extensibility.
 * For segment caching, use MemorySegmentCacheStore instead.
 */

import type {
  CacheStore,
  CacheEntry,
  CacheValue,
  CachePutOptions,
  CacheMetadata,
  CacheValueType,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Default TTL when no explicit value is provided */
const DEFAULT_TTL_SECONDS = 60;

// ============================================================================
// Types
// ============================================================================

interface StoredEntry {
  /** Stored value (streams/responses converted to ArrayBuffer) */
  value: ArrayBuffer | string | object;
  metadata: CacheMetadata;
}

/**
 * In-memory cache store implementation
 */
export class MemoryCacheStore implements CacheStore {
  private cache = new Map<string, StoredEntry>();

  async match<T = CacheValue>(key: string): Promise<CacheEntry<T> | undefined> {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check expiration
    if (entry.metadata.expiresAt && Date.now() > entry.metadata.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Reconstruct value based on original type
    const value = this.reconstructValue(entry);

    return {
      value: value as T,
      metadata: entry.metadata,
    };
  }

  async put<T extends CacheValue>(
    key: string,
    value: T,
    options?: CachePutOptions,
  ): Promise<void> {
    const ttl = options?.ttl ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Date.now() + ttl * 1000;

    // Detect value type and convert for storage
    const { storedValue, valueType, responseHeaders, responseStatus } =
      await this.prepareForStorage(value);

    const metadata: CacheMetadata = {
      ...options?.metadata,
      expiresAt,
      valueType,
      responseHeaders,
      responseStatus,
    };

    this.cache.set(key, {
      value: storedValue,
      metadata,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries (useful for testing)
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (useful for testing/debugging)
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Manually purge expired entries
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;

    for (const [key, entry] of this.cache) {
      if (entry.metadata.expiresAt && now > entry.metadata.expiresAt) {
        this.cache.delete(key);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Prepare a value for storage
   * Converts streams and responses to ArrayBuffer, detects type
   */
  private async prepareForStorage(value: CacheValue): Promise<{
    storedValue: ArrayBuffer | string | object;
    valueType: CacheValueType;
    responseHeaders?: Record<string, string>;
    responseStatus?: number;
  }> {
    // ReadableStream -> ArrayBuffer
    if (value instanceof ReadableStream) {
      return {
        storedValue: await streamToArrayBuffer(value),
        valueType: "stream",
      };
    }

    // Response -> ArrayBuffer + headers/status
    if (value instanceof Response) {
      const headers: Record<string, string> = {};
      value.headers.forEach((v, k) => {
        headers[k] = v;
      });

      return {
        storedValue: await value.clone().arrayBuffer(),
        valueType: "response",
        responseHeaders: headers,
        responseStatus: value.status,
      };
    }

    // ArrayBuffer -> store as-is
    if (value instanceof ArrayBuffer) {
      return {
        storedValue: value,
        valueType: "arraybuffer",
      };
    }

    // String -> store as-is
    if (typeof value === "string") {
      return {
        storedValue: value,
        valueType: "string",
      };
    }

    // Object -> store as-is (JSON-serializable)
    return {
      storedValue: value,
      valueType: "object",
    };
  }

  /**
   * Reconstruct original value type from stored entry
   */
  private reconstructValue(entry: StoredEntry): CacheValue {
    const { value, metadata } = entry;

    switch (metadata.valueType) {
      case "stream":
        return arrayBufferToStream(value as ArrayBuffer);

      case "response": {
        const status = metadata.responseStatus ?? 200;
        // Status codes 204 (No Content) and 304 (Not Modified) cannot have a body
        const isNullBodyStatus = status === 204 || status === 304;
        return new Response(isNullBodyStatus ? null : (value as ArrayBuffer), {
          status,
          headers: metadata.responseHeaders,
        });
      }

      case "arraybuffer":
      case "string":
      case "object":
      default:
        return value as CacheValue;
    }
  }
}

/**
 * Convert a ReadableStream to ArrayBuffer.
 * @internal
 */
async function streamToArrayBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

/**
 * Convert an ArrayBuffer to a ReadableStream.
 * @internal
 */
function arrayBufferToStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  const uint8 = new Uint8Array(buffer);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(uint8);
      controller.close();
    },
  });
}
