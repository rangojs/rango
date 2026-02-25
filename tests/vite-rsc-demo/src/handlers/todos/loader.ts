import { createLoader } from "@rangojs/router";
import { todosStore, type Todo } from "./data.js";

export type TodosData = {
  todos: Todo[];
  stats: {
    total: number;
    completed: number;
    pending: number;
  };
};

/**
 * TodosLoader - fetches all todos with stats
 * Simulates network latency for realistic demo
 */
export const TodosLoader = createLoader(async (_ctx) => {
  "use server";
  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const todos = [...todosStore].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  return {
    todos,
    stats: {
      total: todos.length,
      completed: todos.filter((t) => t.completed).length,
      pending: todos.filter((t) => !t.completed).length,
    },
  } satisfies TodosData;
});

/**
 * TodoDetailLoader - fetches a single todo by ID
 */
export const TodoDetailLoader = createLoader(async (ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const id = ctx.params.id;
  const todo = todosStore.find((t) => t.id === id);

  if (!todo) {
    throw new Error(`Todo with id ${id} not found`);
  }

  return todo;
});
