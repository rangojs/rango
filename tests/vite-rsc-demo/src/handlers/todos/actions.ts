"use server";

import { todosStore, generateId, type Todo } from "./data.js";

/**
 * Add a new todo
 */
export async function addTodo(title: string): Promise<Todo> {
  if (title.includes("error")) {
    throw new Error("Simulated server action error");
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  const newTodo: Todo = {
    id: generateId(),
    title: title.trim(),
    completed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  todosStore.unshift(newTodo);
  console.log(`[Action] Added todo: ${newTodo.title}`);

  return newTodo;
}

/**
 * Toggle todo completion status
 */
export async function toggleTodo(id: string): Promise<Todo | null> {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const todo = todosStore.find((t) => t.id === id);
  if (!todo) {
    console.log(`[Action] Todo not found: ${id}`);
    return null;
  }

  todo.completed = !todo.completed;
  todo.updatedAt = new Date();
  console.log(`[Action] Toggled todo ${id}: completed=${todo.completed}`);

  return todo;
}

/**
 * Delete a todo
 */
export async function deleteTodo(id: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const index = todosStore.findIndex((t) => t.id === id);
  if (index === -1) {
    console.log(`[Action] Todo not found for deletion: ${id}`);
    return false;
  }

  todosStore.splice(index, 1);
  console.log(`[Action] Deleted todo: ${id}`);

  return true;
}

/**
 * Update todo title
 */
export async function updateTodo(
  id: string,
  title: string,
): Promise<Todo | null> {
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const todo = todosStore.find((t) => t.id === id);
  if (!todo) {
    console.log(`[Action] Todo not found: ${id}`);
    return null;
  }

  todo.title = title.trim();
  todo.updatedAt = new Date();
  console.log(`[Action] Updated todo ${id}: title="${todo.title}"`);

  return todo;
}

/**
 * Clear all completed todos
 */
export async function clearCompletedTodos(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const initialLength = todosStore.length;
  const remaining = todosStore.filter((t) => !t.completed);
  todosStore.length = 0;
  todosStore.push(...remaining);

  const deleted = initialLength - remaining.length;
  console.log(`[Action] Cleared ${deleted} completed todos`);

  return deleted;
}
