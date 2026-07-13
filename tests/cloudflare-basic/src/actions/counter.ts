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

export async function submitPrerenderPprAction(
  _previous: string | null,
  formData: FormData,
): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return `cf-prerender-ppr-action:${String(formData.get("value"))}`;
}
