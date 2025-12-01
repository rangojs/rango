import { createLoader } from "rsc-router/loader";
import { boardStore, type Board, type Card } from "./data.js";

export type BoardData = Board;

/**
 * KanbanLoader - fetches the board with columns and cards
 */
export const KanbanLoader = createLoader("kanban", async (_ctx) => {
  "use server";
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Return a copy to prevent mutation issues
  return {
    id: boardStore.id,
    title: boardStore.title,
    columns: [...boardStore.columns].sort((a, b) => a.order - b.order),
    cards: [...boardStore.cards].sort((a, b) => a.order - b.order),
  } satisfies BoardData;
});

/**
 * CardDetailLoader - fetches a single card by ID
 */
export const CardDetailLoader = createLoader("cardDetail", async (ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 200));

  const cardId = ctx.params.cardId;
  const card = boardStore.cards.find((c) => c.id === cardId);

  if (!card) {
    throw new Error(`Card with id ${cardId} not found`);
  }

  const column = boardStore.columns.find((col) => col.id === card.columnId);

  return {
    card: { ...card },
    columnTitle: column?.title ?? "Unknown",
  };
});
