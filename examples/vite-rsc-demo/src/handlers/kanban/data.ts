// Kanban board data types and in-memory store

export type Card = {
  id: string;
  title: string;
  description: string;
  columnId: string;
  order: number;
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type Column = {
  id: string;
  title: string;
  order: number;
};

export type Board = {
  id: string;
  title: string;
  columns: Column[];
  cards: Card[];
};

// Initial mock data
const initialBoard: Board = {
  id: "board-1",
  title: "Project Board",
  columns: [
    { id: "col-todo", title: "To Do", order: 0 },
    { id: "col-progress", title: "In Progress", order: 1 },
    { id: "col-review", title: "In Review", order: 2 },
    { id: "col-done", title: "Done", order: 3 },
  ],
  cards: [
    {
      id: "card-1",
      title: "Set up project structure",
      description: "Initialize the monorepo with proper package configuration and build tooling.",
      columnId: "col-done",
      order: 0,
      labels: ["setup", "infrastructure"],
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-02"),
    },
    {
      id: "card-2",
      title: "Design database schema",
      description: "Create the initial database schema for users, projects, and tasks.",
      columnId: "col-done",
      order: 1,
      labels: ["database", "design"],
      createdAt: new Date("2024-01-02"),
      updatedAt: new Date("2024-01-03"),
    },
    {
      id: "card-3",
      title: "Implement authentication",
      description: "Add user authentication with OAuth providers and session management.",
      columnId: "col-review",
      order: 0,
      labels: ["auth", "security"],
      createdAt: new Date("2024-01-03"),
      updatedAt: new Date("2024-01-04"),
    },
    {
      id: "card-4",
      title: "Build API endpoints",
      description: "Create REST API endpoints for CRUD operations on all resources.",
      columnId: "col-progress",
      order: 0,
      labels: ["api", "backend"],
      createdAt: new Date("2024-01-04"),
      updatedAt: new Date("2024-01-04"),
    },
    {
      id: "card-5",
      title: "Create dashboard UI",
      description: "Design and implement the main dashboard with charts and metrics.",
      columnId: "col-progress",
      order: 1,
      labels: ["ui", "frontend"],
      createdAt: new Date("2024-01-05"),
      updatedAt: new Date("2024-01-05"),
    },
    {
      id: "card-6",
      title: "Add unit tests",
      description: "Write comprehensive unit tests for all utility functions and hooks.",
      columnId: "col-todo",
      order: 0,
      labels: ["testing"],
      createdAt: new Date("2024-01-06"),
      updatedAt: new Date("2024-01-06"),
    },
    {
      id: "card-7",
      title: "Set up CI/CD pipeline",
      description: "Configure GitHub Actions for automated testing and deployment.",
      columnId: "col-todo",
      order: 1,
      labels: ["devops", "infrastructure"],
      createdAt: new Date("2024-01-07"),
      updatedAt: new Date("2024-01-07"),
    },
    {
      id: "card-8",
      title: "Write documentation",
      description: "Document API endpoints, component props, and setup instructions.",
      columnId: "col-todo",
      order: 2,
      labels: ["docs"],
      createdAt: new Date("2024-01-08"),
      updatedAt: new Date("2024-01-08"),
    },
  ],
};

// Mutable in-memory store
export const boardStore: Board = { ...initialBoard };

// Helper to generate unique IDs
let nextCardId = 9;
export function generateCardId(): string {
  return `card-${nextCardId++}`;
}

// Label colors for display
export const labelColors: Record<string, string> = {
  setup: "#10b981",
  infrastructure: "#6366f1",
  database: "#f59e0b",
  design: "#ec4899",
  auth: "#ef4444",
  security: "#dc2626",
  api: "#8b5cf6",
  backend: "#3b82f6",
  ui: "#14b8a6",
  frontend: "#06b6d4",
  testing: "#84cc16",
  devops: "#f97316",
  docs: "#a855f7",
};
