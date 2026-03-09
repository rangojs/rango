"use server";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function slowAction() {
  await delay(20000);
  return "Should not complete";
}
