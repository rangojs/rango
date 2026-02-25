// In-memory todo store (simulates database)
export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// Initial mock data
const initialTodos: Todo[] = [
  {
    id: "1",
    title: "Learn RSC Router",
    completed: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
  },
  {
    id: "2",
    title: "Build a demo app",
    completed: true,
    createdAt: new Date("2024-01-03"),
    updatedAt: new Date("2024-01-03"),
  },
  {
    id: "3",
    title: "Test server actions",
    completed: false,
    createdAt: new Date("2024-01-04"),
    updatedAt: new Date("2024-01-04"),
  },
  {
    id: "4",
    title: "Implement streaming",
    completed: false,
    createdAt: new Date("2024-01-05"),
    updatedAt: new Date("2024-01-05"),
  },
  {
    id: "5",
    title: "Add performance metrics",
    completed: false,
    createdAt: new Date("2024-01-06"),
    updatedAt: new Date("2024-01-06"),
  },
];

// Mutable in-memory store
export const todosStore: Todo[] = [...initialTodos];

// Helper to generate unique IDs
let nextId = 6;
export function generateId(): string {
  return String(nextId++);
}
