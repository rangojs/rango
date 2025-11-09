"use server";

let serverCounter = 0;

export async function getServerCounter() {
  return serverCounter;
}

export const updateServerCounter = async (change: number) => {
  serverCounter += change;
  return serverCounter;
};
