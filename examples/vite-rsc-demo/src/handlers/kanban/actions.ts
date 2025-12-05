"use server";

import { boardStore, generateCardId, type Card } from "./data.js";

/**
 * Add a new card to a column
 */
export async function kanbanAddCard(
  columnId: string,
  title: string,
  description: string = ""
): Promise<Card> {
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Error trigger: adding to error column
  if (columnId === "col-error") {
    throw new Error("Cannot add cards to the Error Test column - this is a simulated server error");
  }

  // Error trigger: card named "error"
  if (title.trim().toLowerCase() === "error") {
    throw new Error("Card title 'error' triggers a simulated server error");
  }

  const cardsInColumn = boardStore.cards.filter((c) => c.columnId === columnId);
  const maxOrder = cardsInColumn.length > 0
    ? Math.max(...cardsInColumn.map((c) => c.order))
    : -1;

  const newCard: Card = {
    id: generateCardId(),
    title: title.trim(),
    description: description.trim(),
    columnId,
    order: maxOrder + 1,
    labels: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  boardStore.cards.push(newCard);
  console.log(`[Kanban] Added card: ${newCard.title} to ${columnId}`);

  return newCard;
}

/**
 * Move a card to a different column and/or position
 */
export async function kanbanMoveCard(
  cardId: string,
  targetColumnId: string,
  targetIndex: number
): Promise<Card | null> {
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Error trigger: moving to error column
  if (targetColumnId === "col-error") {
    throw new Error("Cannot move cards to the Error Test column - this is a simulated server error");
  }

  const card = boardStore.cards.find((c) => c.id === cardId);
  if (!card) {
    console.log(`[Kanban] Card not found: ${cardId}`);
    return null;
  }

  const oldColumnId = card.columnId;

  // Update the card's column
  card.columnId = targetColumnId;
  card.updatedAt = new Date();

  // Reorder cards in target column
  const cardsInTargetColumn = boardStore.cards
    .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
    .sort((a, b) => a.order - b.order);

  // Insert at target index
  cardsInTargetColumn.splice(targetIndex, 0, card);

  // Update order for all cards in target column
  cardsInTargetColumn.forEach((c, idx) => {
    c.order = idx;
  });

  // If moved from different column, reorder old column
  if (oldColumnId !== targetColumnId) {
    const cardsInOldColumn = boardStore.cards
      .filter((c) => c.columnId === oldColumnId)
      .sort((a, b) => a.order - b.order);

    cardsInOldColumn.forEach((c, idx) => {
      c.order = idx;
    });
  }

  console.log(`[Kanban] Moved card ${cardId} to ${targetColumnId} at index ${targetIndex}`);

  return card;
}

/**
 * Update card details
 */
export async function kanbanUpdateCard(
  cardId: string,
  updates: { title?: string; description?: string; labels?: string[] }
): Promise<Card | null> {
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Error trigger: renaming to "error"
  if (updates.title?.trim().toLowerCase() === "error") {
    throw new Error("Card title 'error' triggers a simulated server error");
  }

  const card = boardStore.cards.find((c) => c.id === cardId);
  if (!card) {
    console.log(`[Kanban] Card not found: ${cardId}`);
    return null;
  }

  if (updates.title !== undefined) {
    card.title = updates.title.trim();
  }
  if (updates.description !== undefined) {
    card.description = updates.description.trim();
  }
  if (updates.labels !== undefined) {
    card.labels = updates.labels;
  }
  card.updatedAt = new Date();

  console.log(`[Kanban] Updated card ${cardId}`);

  return card;
}

/**
 * Delete a card
 */
export async function kanbanDeleteCard(cardId: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const index = boardStore.cards.findIndex((c) => c.id === cardId);
  if (index === -1) {
    console.log(`[Kanban] Card not found for deletion: ${cardId}`);
    return false;
  }

  const [deleted] = boardStore.cards.splice(index, 1);

  // Reorder remaining cards in the column
  const cardsInColumn = boardStore.cards
    .filter((c) => c.columnId === deleted.columnId)
    .sort((a, b) => a.order - b.order);

  cardsInColumn.forEach((c, idx) => {
    c.order = idx;
  });

  console.log(`[Kanban] Deleted card: ${cardId}`);

  return true;
}
