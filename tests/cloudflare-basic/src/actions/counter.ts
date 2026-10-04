"use server";

// Simple in-memory counter (in real app, use D1/KV)
let counter = 0;

export async function incrementCounter(): Promise<number> {
  counter += 1;
  return counter;
}

export async function decrementCounter(): Promise<number> {
  counter -= 1;
  return counter;
}

export async function getCounter(): Promise<number> {
  return counter;
}

export interface PrerenderPprActionResult {
  streamed: Promise<string>;
}

export async function submitPrerenderPprAction(
  _previous: PrerenderPprActionResult | null,
  formData: FormData,
): Promise<PrerenderPprActionResult> {
  const value = String(formData.get("value"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    streamed: new Promise((resolve) =>
      setTimeout(() => resolve(`cf-prerender-ppr-action:${value}`), 1_200),
    ),
  };
}
