"use client";

import { useState, useTransition, useEffect, useOptimistic } from "react";
import { useLoader, Link, useNavigation } from "rsc-router/client";
import { CardDetailLoader } from "./loader.js";
import { kanbanUpdateCard, kanbanDeleteCard } from "./actions.js";
import { labelColors } from "./data.js";
import { LoadingSpinner } from "../shop/components/loading.js";

const styles = {
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "10vh",
    zIndex: 1000,
  },
  modal: {
    background: "white",
    borderRadius: "8px",
    width: "100%",
    maxWidth: "600px",
    maxHeight: "80vh",
    overflow: "auto",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
  },
  header: {
    padding: "1.5rem",
    borderBottom: "1px solid #e2e8f0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  title: {
    fontSize: "1.25rem",
    fontWeight: 600,
    color: "#1e293b",
    margin: 0,
    flex: 1,
  },
  closeButton: {
    background: "transparent",
    border: "none",
    fontSize: "1.5rem",
    cursor: "pointer",
    color: "#64748b",
    padding: "0.25rem",
    lineHeight: 1,
  },
  body: {
    padding: "1.5rem",
  },
  section: {
    marginBottom: "1.5rem",
  },
  sectionTitle: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.5rem",
  },
  columnBadge: {
    display: "inline-block",
    background: "#f1f5f9",
    color: "#475569",
    padding: "0.25rem 0.75rem",
    borderRadius: "4px",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  description: {
    color: "#475569",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap" as const,
  },
  emptyDescription: {
    color: "#94a3b8",
    fontStyle: "italic" as const,
  },
  labelsContainer: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "0.25rem 0.5rem",
    borderRadius: "4px",
    color: "white",
  },
  textarea: {
    width: "100%",
    padding: "0.75rem",
    fontSize: "0.875rem",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    resize: "vertical" as const,
    minHeight: "100px",
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  input: {
    width: "100%",
    padding: "0.75rem",
    fontSize: "1rem",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  buttonGroup: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
  },
  saveButton: {
    background: "#3b82f6",
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  cancelButton: {
    background: "#f1f5f9",
    color: "#64748b",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  deleteButton: {
    background: "#fee2e2",
    color: "#dc2626",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
    marginLeft: "auto",
  },
  pending: {
    cursor: "wait" as const,
  },
  meta: {
    fontSize: "0.75rem",
    color: "#94a3b8",
  },
};

const allLabels = Object.keys(labelColors);

// Loading skeleton for card detail modal
export function CardDetailSkeleton() {
  const skeletonStyle = {
    background: "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
    backgroundSize: "200% 100%",
    animation: "shimmer 1.5s infinite",
    borderRadius: "4px",
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <div
            style={{ ...skeletonStyle, height: "24px", width: "60%", flex: 1 }}
          />
          <button style={styles.closeButton}>x</button>
        </div>
        <div style={styles.body}>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Column</div>
            <div style={{ ...skeletonStyle, height: "28px", width: "100px" }} />
          </div>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Description</div>
            <div style={{ ...skeletonStyle, height: "80px", width: "100%" }} />
          </div>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Labels</div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <div
                style={{ ...skeletonStyle, height: "24px", width: "60px" }}
              />
              <div
                style={{ ...skeletonStyle, height: "24px", width: "50px" }}
              />
              <div
                style={{ ...skeletonStyle, height: "24px", width: "70px" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CardDetailContent() {
  const { card, columnTitle } = useLoader(CardDetailLoader);
  const { navigate } = useNavigation();
  const [isPending, startTransition] = useTransition();

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editTitle, setEditTitle] = useState(card.title);
  const [editDescription, setEditDescription] = useState(card.description);
  const [selectedLabels, setSelectedLabels] = useState<string[]>(card.labels);
  const [optimisticTitle, setOptimisticTitle] = useOptimistic(card.title);
  const [optimisticDescription, setOptimisticDescription] = useOptimistic(
    card.description
  );

  // Client-side error trigger: if description contains "error", throw during render
  if (card.description.toLowerCase().includes("error")) {
    throw new Error(
      "Card description contains 'error' - this is a simulated client-side error"
    );
  }

  // Sync state when card data changes (e.g., from cross-tab sync)
  useEffect(() => {
    setSelectedLabels(card.labels);
    setEditTitle(card.title);
    setEditDescription(card.description);
  }, [card.labels, card.title, card.description]);

  function handleClose() {
    navigate("/kanban");
  }

  function handleSaveTitle() {
    const newTitle = editTitle.trim();
    if (newTitle === card.title) {
      setIsEditingTitle(false);
      return;
    }

    setIsEditingTitle(false);

    startTransition(async () => {
      setOptimisticTitle(newTitle);
      await kanbanUpdateCard(card.id, { title: newTitle });
    });
  }

  function handleSaveDescription() {
    const newDescription = editDescription.trim();
    if (newDescription === card.description) {
      setIsEditingDescription(false);
      return;
    }

    setIsEditingDescription(false);

    startTransition(async () => {
      setOptimisticDescription(newDescription);
      await kanbanUpdateCard(card.id, { description: newDescription });
    });
  }

  function handleToggleLabel(label: string) {
    const newLabels = selectedLabels.includes(label)
      ? selectedLabels.filter((l) => l !== label)
      : [...selectedLabels, label];

    setSelectedLabels(newLabels);

    startTransition(async () => {
      await kanbanUpdateCard(card.id, { labels: newLabels });
    });
  }

  function handleDelete() {
    if (!confirm("Are you sure you want to delete this card?")) return;

    startTransition(async () => {
      await kanbanDeleteCard(card.id);
      navigate("/kanban");
    });
  }

  return (
    <div style={styles.overlay} onClick={handleClose} data-testid="card-modal-overlay">
      <div
        data-testid="card-modal"
        style={{ ...styles.modal, ...(isPending ? styles.pending : {}) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          {isEditingTitle ? (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveTitle();
                if (e.key === "Escape") {
                  setEditTitle(card.title);
                  setIsEditingTitle(false);
                }
              }}
              style={{ ...styles.input, flex: 1, marginRight: "1rem" }}
              autoFocus
            />
          ) : (
            <h2
              style={{ ...styles.title, cursor: "pointer" }}
              onClick={() => setIsEditingTitle(true)}
              data-testid="card-title"
            >
              {optimisticTitle}
            </h2>
          )}
          <button style={styles.closeButton} onClick={handleClose} data-testid="card-modal-close">
            x
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Column</div>
            <span style={styles.columnBadge}>{columnTitle}</span>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Description</div>
            {isEditingDescription ? (
              <div>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  style={styles.textarea}
                  placeholder="Add a description..."
                  autoFocus
                />
                <div style={styles.buttonGroup}>
                  <button
                    style={styles.saveButton}
                    onClick={handleSaveDescription}
                  >
                    Save
                  </button>
                  <button
                    style={styles.cancelButton}
                    onClick={() => {
                      setEditDescription(card.description);
                      setIsEditingDescription(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  ...styles.description,
                  ...(optimisticDescription ? {} : styles.emptyDescription),
                  cursor: "pointer",
                  padding: "0.5rem",
                  borderRadius: "4px",
                  background: "#f8fafc",
                }}
                onClick={() => setIsEditingDescription(true)}
              >
                {optimisticDescription || "Click to add a description..."}
              </div>
            )}
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Labels</div>
            <div style={styles.labelsContainer}>
              {allLabels.map((label) => (
                <button
                  key={label}
                  onClick={() => handleToggleLabel(label)}
                  style={{
                    ...styles.label,
                    background: labelColors[label],
                    opacity: selectedLabels.includes(label) ? 1 : 0.4,
                    cursor: "pointer",
                    border: "none",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Details</div>
            <div style={styles.meta}>
              <div>Created: {card.createdAt.toLocaleDateString("en-US")}</div>
              <div>Updated: {card.updatedAt.toLocaleDateString("en-US")}</div>
              <div>
                <LoadingSpinner />
              </div>
            </div>
          </div>

          <div
            style={{
              ...styles.buttonGroup,
              borderTop: "1px solid #e2e8f0",
              paddingTop: "1rem",
            }}
          >
            <Link to="/kanban" style={{ textDecoration: "none" }}>
              <button style={styles.cancelButton} data-testid="back-to-board">Back to Board</button>
            </Link>
            <button style={styles.deleteButton} onClick={handleDelete} data-testid="delete-card">
              Delete Card
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
