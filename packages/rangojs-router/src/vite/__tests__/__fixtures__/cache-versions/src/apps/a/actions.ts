"use server";

let likes = 0;

export async function like(): Promise<void> {
  likes += 1;
}
