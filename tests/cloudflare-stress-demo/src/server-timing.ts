/**
 * Server-Timing header parsing, shared by the worker's /timing endpoint
 * (worker.rsc.tsx) and the dashboard's client-side breakdown
 * (pages/dashboard-client.tsx). Pure — safe in both environments.
 */
export function parseServerTiming(
  header: string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const name = part
      .trim()
      .match(/^([^;]+)/)?.[1]
      ?.trim();
    const dur = part.match(/dur=([0-9.]+)/)?.[1];
    if (name && dur) out[name] = parseFloat(dur);
  }
  return out;
}
