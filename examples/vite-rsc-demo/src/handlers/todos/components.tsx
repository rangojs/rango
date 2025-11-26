"use client";

import { useState, useTransition, useRef, useEffect, use } from "react";
import type { Todo } from "./data.js";
import {
  addTodo,
  toggleTodo,
  deleteTodo,
  updateTodo,
  clearCompleted,
} from "./actions.js";
import { flushSync } from "react-dom";
const actionAddTodo = addTodo;
const styles = {
  form: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "1.5rem",
  },
  input: {
    flex: 1,
    padding: "0.75rem 1rem",
    fontSize: "1rem",
    border: "2px solid #e2e8f0",
    borderRadius: "8px",
    outline: "none",
    transition: "border-color 0.2s",
  },
  button: {
    padding: "0.75rem 1.5rem",
    fontSize: "1rem",
    fontWeight: 600,
    color: "white",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    transition: "opacity 0.2s, transform 0.1s",
  },
  todoItem: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "1rem",
    background: "white",
    borderRadius: "8px",
    marginBottom: "0.5rem",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    transition: "transform 0.1s, box-shadow 0.1s",
  },
  checkbox: {
    width: "20px",
    height: "20px",
    cursor: "pointer",
    accentColor: "#667eea",
  },
  todoText: {
    flex: 1,
    fontSize: "1rem",
  },
  todoTextCompleted: {
    textDecoration: "line-through",
    color: "#94a3b8",
  },
  deleteButton: {
    padding: "0.5rem 0.75rem",
    fontSize: "0.875rem",
    color: "#dc2626",
    background: "#fee2e2",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    transition: "background 0.2s",
  },
  editButton: {
    padding: "0.5rem 0.75rem",
    fontSize: "0.875rem",
    color: "#0284c7",
    background: "#e0f2fe",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    transition: "background 0.2s",
  },
  stats: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "1rem",
    background: "#f8fafc",
    borderRadius: "8px",
    marginBottom: "1rem",
    fontSize: "0.875rem",
    color: "#64748b",
  },
  clearButton: {
    padding: "0.5rem 1rem",
    fontSize: "0.875rem",
    color: "#64748b",
    background: "transparent",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    cursor: "pointer",
    transition: "background 0.2s",
  },
  pending: {
    opacity: 0.6,
    pointerEvents: "none" as const,
  },
};

export function AddTodoForm() {
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  console.log("AddTodoForm renders.....");
  useEffect(() => {
    if (!isPending) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [isPending]);
  async function handleSubmit(formData: FormData) {
    const title = formData.get("title") as string;

    if (!title?.trim()) return;

    startTransition(async () => {
      console.log("addd", actionAddTodo.name);
      console.dir(actionAddTodo);

      const res = await actionAddTodo(title);

      // formRef.current?.reset();
      inputRef.current?.focus({ preventScroll: true });
      console.log("AddTodoForm handleSubmit Transition done");
    });
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      style={{ ...styles.form, ...(isPending ? styles.pending : {}) }}
    >
      <input
        key="todo-input"
        ref={inputRef}
        type="text"
        name="title"
        placeholder="What needs to be done?"
        style={styles.input}
        disabled={isPending}
        autoComplete="off"
        autoFocus
      />
      <button type="submit" style={styles.button} disabled={isPending}>
        {isPending ? "Adding..." : "Add Todo"}
      </button>
    </form>
  );
}

export function TodoItem({ todo }: { todo: Todo }) {
  const [isPending, startTransition] = useTransition();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(todo.title);

  function handleToggle() {
    startTransition(async () => {
      await toggleTodo(todo.id);
    });
  }

  function handleDelete() {
    startTransition(async () => {
      await deleteTodo(todo.id);
    });
  }

  function handleEdit() {
    if (isEditing && editValue.trim() !== todo.title) {
      startTransition(async () => {
        await updateTodo(todo.id, editValue);
        setIsEditing(false);
      });
    } else {
      setIsEditing(!isEditing);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      handleEdit();
    } else if (e.key === "Escape") {
      setEditValue(todo.title);
      setIsEditing(false);
    }
  }

  return (
    <div style={{ ...styles.todoItem, ...(isPending ? styles.pending : {}) }}>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={handleToggle}
        style={styles.checkbox}
        disabled={isPending}
      />
      {isEditing ? (
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleEdit}
          style={{ ...styles.input, flex: 1 }}
          autoFocus
        />
      ) : (
        <span
          style={{
            ...styles.todoText,
            ...(todo.completed ? styles.todoTextCompleted : {}),
          }}
        >
          {todo.title}
        </span>
      )}
      <button
        onClick={handleEdit}
        style={styles.editButton}
        disabled={isPending}
      >
        {isEditing ? "Save" : "Edit"}
      </button>
      <button
        onClick={handleDelete}
        style={styles.deleteButton}
        disabled={isPending}
      >
        Delete
      </button>
    </div>
  );
}

export function TodoStats({
  total,
  completed,
  pending,
}: {
  total: number;
  completed: number;
  pending: number;
}) {
  const [isPending, startTransition] = useTransition();

  function handleClearCompleted() {
    startTransition(async () => {
      await clearCompleted();
    });
  }

  return (
    <div style={{ ...styles.stats, ...(isPending ? styles.pending : {}) }}>
      <span>
        {pending} item{pending !== 1 ? "s" : ""} left | {completed} completed |{" "}
        {total} total
      </span>
      {completed > 0 && (
        <button
          onClick={handleClearCompleted}
          style={styles.clearButton}
          disabled={isPending}
        >
          {isPending ? "Clearing..." : "Clear completed"}
        </button>
      )}
    </div>
  );
}
