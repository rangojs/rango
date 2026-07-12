// In-process record of prerender SWR onRevalidate schedulings. router.tsx's
// prerender.onRevalidate pushes here; the /od-swr-log route serves it as JSON
// so the e2e can observe that a stale overlay hit scheduled a revalidation.
export const swrLog: Array<{
  route: string;
  params: Record<string, string>;
}> = [];
