/**
 * Raw-JSON short-circuit shared by the stress groups' bench/echo handlers.
 * Throwing the Response bypasses RSC rendering — these handlers exist to
 * measure routing, not the render pipeline.
 */
export function jsonThrow(data: unknown): never {
  throw new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
