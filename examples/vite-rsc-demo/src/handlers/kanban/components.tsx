"use client";

import { useState, useTransition, useOptimistic, useRef } from "react";
import { Link } from "rsc-router/browser";
import type { Card, Column, Board } from "./data.js";
import { labelColors } from "./data.js";
import { kanbanAddCard, kanbanMoveCard, kanbanDeleteCard } from "./actions.js";

const styles = {
  board: {
    display: "flex",
    gap: "1rem",
    padding: "1rem",
    overflowX: "auto" as const,
    minHeight: "calc(100vh - 200px)",
  },
  column: {
    background: "#f1f5f9",
    borderRadius: "8px",
    padding: "0.75rem",
    minWidth: "280px",
    maxWidth: "280px",
    display: "flex",
    flexDirection: "column" as const,
    maxHeight: "calc(100vh - 220px)",
  },
  columnHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.75rem",
    padding: "0 0.25rem",
  },
  columnTitle: {
    fontWeight: 600,
    fontSize: "0.875rem",
    color: "#475569",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  columnCount: {
    background: "#e2e8f0",
    color: "#64748b",
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "0.125rem 0.5rem",
    borderRadius: "10px",
  },
  cardList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
    flex: 1,
    overflowY: "auto" as const,
    paddingBottom: "0.5rem",
  },
  card: {
    background: "white",
    borderRadius: "6px",
    padding: "0.75rem",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    cursor: "grab",
    transition: "box-shadow 0.2s, transform 0.1s",
  },
  cardDragging: {
    opacity: 0.5,
    transform: "rotate(3deg)",
  },
  cardOver: {
    borderTop: "2px solid #3b82f6",
  },
  cardTitle: {
    fontSize: "0.875rem",
    fontWeight: 500,
    color: "#1e293b",
    marginBottom: "0.5rem",
    wordBreak: "break-word" as const,
  },
  cardLabels: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "0.25rem",
    marginTop: "0.5rem",
  },
  label: {
    fontSize: "0.625rem",
    fontWeight: 600,
    padding: "0.125rem 0.375rem",
    borderRadius: "3px",
    color: "white",
    textTransform: "uppercase" as const,
  },
  addCardButton: {
    background: "transparent",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    padding: "0.5rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    width: "100%",
    marginTop: "0.5rem",
  },
  addCardForm: {
    background: "white",
    borderRadius: "6px",
    padding: "0.75rem",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    fontSize: "0.875rem",
    border: "1px solid #e2e8f0",
    borderRadius: "4px",
    marginBottom: "0.5rem",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  buttonGroup: {
    display: "flex",
    gap: "0.5rem",
  },
  submitButton: {
    background: "#3b82f6",
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  cancelButton: {
    background: "#f1f5f9",
    color: "#64748b",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  pending: {
    opacity: 0.6,
  },
};

type OptimisticCard = Card & { pending?: boolean };

type OptimisticAction =
  | { type: "add"; card: Card }
  | { type: "move"; cardId: string; columnId: string; order: number }
  | { type: "delete"; cardId: string }
  | { type: "update"; cardId: string; updates: Partial<Card> };

function applyOptimisticUpdate(
  cards: OptimisticCard[],
  action: OptimisticAction
): OptimisticCard[] {
  switch (action.type) {
    case "add":
      return [...cards, { ...action.card, pending: true }];

    case "move": {
      const cardIndex = cards.findIndex((c) => c.id === action.cardId);
      if (cardIndex === -1) return cards;

      const newCards = cards.map((c) =>
        c.id === action.cardId
          ? {
              ...c,
              columnId: action.columnId,
              order: action.order,
              pending: true,
            }
          : c
      );

      // Reorder cards in target column
      const targetCards = newCards
        .filter((c) => c.columnId === action.columnId)
        .sort((a, b) => {
          if (a.id === action.cardId) return action.order - b.order - 0.5;
          if (b.id === action.cardId) return a.order - action.order + 0.5;
          return a.order - b.order;
        });

      targetCards.forEach((c, idx) => {
        const card = newCards.find((nc) => nc.id === c.id);
        if (card) card.order = idx;
      });

      return newCards;
    }

    case "delete":
      return cards.filter((c) => c.id !== action.cardId);

    case "update":
      return cards.map((c) =>
        c.id === action.cardId ? { ...c, ...action.updates, pending: true } : c
      );

    default:
      return cards;
  }
}

export function KanbanBoard({ board }: { board: Board }) {
  const [isPending, startTransition] = useTransition();
  const [optimisticCards, setOptimisticCards] = useOptimistic<
    OptimisticCard[],
    OptimisticAction
  >(board.cards, applyOptimisticUpdate);

  const [draggedCard, setDraggedCard] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function handleDragStart(cardId: string) {
    setDraggedCard(cardId);
  }

  function handleDragEnd() {
    setDraggedCard(null);
    setDragOverColumn(null);
    setDragOverIndex(null);
  }

  function handleDragOver(e: React.DragEvent, columnId: string, index: number) {
    e.preventDefault();
    setDragOverColumn(columnId);
    setDragOverIndex(index);
  }

  function handleDrop(columnId: string, dropIndex: number) {
    if (!draggedCard) return;

    // Capture and clear immediately to prevent double-calls
    const cardToMove = draggedCard;
    setDraggedCard(null);
    setDragOverColumn(null);
    setDragOverIndex(null);

    const card = optimisticCards.find((c) => c.id === cardToMove);
    if (!card) return;

    // Skip if dropping in same position
    const cardsInColumn = optimisticCards
      .filter((c) => c.columnId === columnId)
      .sort((a, b) => a.order - b.order);

    if (card.columnId === columnId) {
      const currentIndex = cardsInColumn.findIndex((c) => c.id === card.id);
      if (currentIndex === dropIndex || currentIndex === dropIndex - 1) {
        return;
      }
    }

    startTransition(async () => {
      setOptimisticCards({
        type: "move",
        cardId: cardToMove,
        columnId,
        order: dropIndex,
      });
      await kanbanMoveCard(cardToMove, columnId, dropIndex);
    });
  }

  function handleAddCard(columnId: string, title: string) {
    const tempId = `temp-${Date.now()}`;
    const newCard: Card = {
      id: tempId,
      title,
      description: "",
      columnId,
      order: optimisticCards.filter((c) => c.columnId === columnId).length,
      labels: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    startTransition(async () => {
      setOptimisticCards({ type: "add", card: newCard });
      await kanbanAddCard(columnId, title);
    });
  }

  function handleDeleteCard(cardId: string) {
    startTransition(async () => {
      setOptimisticCards({ type: "delete", cardId });
      await kanbanDeleteCard(cardId);
    });
  }

  return (
    <div style={styles.board}>
      {board.columns.map((column) => (
        <KanbanColumn
          key={column.id}
          column={column}
          cards={optimisticCards
            .filter((c) => c.columnId === column.id)
            .sort((a, b) => a.order - b.order)}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onAddCard={handleAddCard}
          onDeleteCard={handleDeleteCard}
          isDragOver={dragOverColumn === column.id}
          dragOverIndex={dragOverColumn === column.id ? dragOverIndex : null}
          draggedCardId={draggedCard}
        />
      ))}
    </div>
  );
}

type KanbanColumnProps = {
  column: Column;
  cards: OptimisticCard[];
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, columnId: string, index: number) => void;
  onDrop: (columnId: string, index: number) => void;
  onAddCard: (columnId: string, title: string) => void;
  onDeleteCard: (cardId: string) => void;
  isDragOver: boolean;
  dragOverIndex: number | null;
  draggedCardId: string | null;
};

function KanbanColumn({
  column,
  cards,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onAddCard,
  onDeleteCard,
  isDragOver,
  dragOverIndex,
  draggedCardId,
}: KanbanColumnProps) {
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cardListRef = useRef<HTMLDivElement>(null);

  function handleAddClick() {
    setIsAddingCard(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newCardTitle.trim()) return;

    onAddCard(column.id, newCardTitle.trim());
    setNewCardTitle("");
    // Keep form open, focus for next card, and scroll to bottom to show new card
    setTimeout(() => {
      inputRef.current?.focus();
      cardListRef.current?.scrollTo({
        top: cardListRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 0);
  }

  function handleCancel() {
    setNewCardTitle("");
    setIsAddingCard(false);
  }

  return (
    <div
      style={{
        ...styles.column,
        ...(isDragOver ? { background: "#e2e8f0" } : {}),
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (cards.length === 0) {
          onDragOver(e, column.id, 0);
        }
      }}
      onDrop={() => {
        if (cards.length === 0) {
          onDrop(column.id, 0);
        }
      }}
    >
      <div style={styles.columnHeader}>
        <span style={styles.columnTitle}>{column.title}</span>
        <span style={styles.columnCount}>{cards.length}</span>
      </div>

      <div
        ref={cardListRef}
        style={styles.cardList}
        onDragOver={(e) => {
          e.preventDefault();
          // When dragging over the card list area (not a card), set index to end
          const target = e.target as HTMLElement;
          if (target === e.currentTarget) {
            onDragOver(e, column.id, cards.length);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          // Allow dropping at the end of the list
          if (dragOverIndex !== null) {
            onDrop(column.id, dragOverIndex);
          }
        }}
      >
        {cards.map((card, index) => (
          <div key={card.id}>
            {dragOverIndex === index &&
              isDragOver &&
              draggedCardId !== card.id && (
                <div
                  style={{
                    height: "4px",
                    background: "#3b82f6",
                    borderRadius: "2px",
                    marginBottom: "0.5rem",
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDragOver(e, column.id, index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDrop(column.id, index);
                  }}
                />
              )}
            <KanbanCard
              card={card}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, column.id, index)}
              onDrop={() => onDrop(column.id, index)}
              onDelete={onDeleteCard}
              isDragging={draggedCardId === card.id}
            />
          </div>
        ))}
        {dragOverIndex === cards.length && isDragOver && (
          <div
            style={{
              height: "4px",
              background: "#3b82f6",
              borderRadius: "2px",
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDragOver(e, column.id, cards.length);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDrop(column.id, cards.length);
            }}
          />
        )}
      </div>

      {isAddingCard ? (
        <form onSubmit={handleSubmit} style={styles.addCardForm}>
          <input
            ref={inputRef}
            type="text"
            value={newCardTitle}
            onChange={(e) => setNewCardTitle(e.target.value)}
            placeholder="Enter card title..."
            style={styles.input}
            onKeyDown={(e) => {
              if (e.key === "Escape") handleCancel();
            }}
          />
          <div style={styles.buttonGroup}>
            <button type="submit" style={styles.submitButton}>
              Add Card
            </button>
            <button
              type="button"
              onClick={handleCancel}
              style={styles.cancelButton}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={handleAddClick}
          style={styles.addCardButton}
          onMouseOver={(e) => {
            e.currentTarget.style.background = "#e2e8f0";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          + Add a card
        </button>
      )}
    </div>
  );
}

type KanbanCardProps = {
  card: OptimisticCard;
  onDragStart: (cardId: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDelete: (cardId: string) => void;
  isDragging: boolean;
};

function KanbanCard({
  card,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onDelete,
  isDragging,
}: KanbanCardProps) {
  const [showActions, setShowActions] = useState(false);

  // Only prevent dragging for unsaved cards (temp IDs) - saved cards can be moved even while pending
  const isUnsaved = card.id.startsWith("temp-");

  return (
    <div
      draggable={!isUnsaved}
      onDragStart={() => !isUnsaved && onDragStart(card.id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(e);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop();
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      style={{
        ...styles.card,
        ...(isDragging ? styles.cardDragging : {}),
        ...(card.pending ? styles.pending : {}),
        position: "relative" as const,
      }}
    >
      <Link
        to={`/kanban/card/${card.id}`}
        style={{ textDecoration: "none", color: "inherit" }}
      >
        <div style={styles.cardTitle}>{card.title}</div>
      </Link>

      {card.labels.length > 0 && (
        <div style={styles.cardLabels}>
          {card.labels.map((label) => (
            <span
              key={label}
              style={{
                ...styles.label,
                background: labelColors[label] || "#94a3b8",
              }}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {showActions && !card.pending && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(card.id);
          }}
          style={{
            position: "absolute",
            top: "0.5rem",
            right: "0.5rem",
            background: "#fee2e2",
            border: "none",
            borderRadius: "4px",
            padding: "0.25rem 0.5rem",
            cursor: "pointer",
            fontSize: "0.75rem",
            color: "#dc2626",
          }}
        >
          x
        </button>
      )}
    </div>
  );
}
