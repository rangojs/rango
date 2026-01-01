/**
 * Sample data for loaders demo
 * Simulates a simple user/stats system
 */

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
  lastLogin: Date;
}

export interface Stats {
  totalUsers: number;
  activeToday: number;
  newThisWeek: number;
  pageViews: number;
}

// In-memory user store
export const usersStore: User[] = [
  {
    id: "1",
    name: "Alice Johnson",
    email: "alice@example.com",
    role: "admin",
    lastLogin: new Date(),
  },
  {
    id: "2",
    name: "Bob Smith",
    email: "bob@example.com",
    role: "user",
    lastLogin: new Date(Date.now() - 3600000),
  },
  {
    id: "3",
    name: "Charlie Brown",
    email: "charlie@example.com",
    role: "user",
    lastLogin: new Date(Date.now() - 86400000),
  },
  {
    id: "4",
    name: "Diana Prince",
    email: "diana@example.com",
    role: "guest",
    lastLogin: new Date(Date.now() - 172800000),
  },
];

// Simulated stats that can be updated via actions
let statsData: Stats = {
  totalUsers: usersStore.length,
  activeToday: 2,
  newThisWeek: 1,
  pageViews: 1234,
};

// Counter for tracking loader calls (useful for demonstrating revalidation)
let loaderCallCount = 0;
let fetchableLoaderCallCount = 0;

export function getStats(): Stats {
  return { ...statsData };
}

export function incrementPageViews(): Stats {
  statsData.pageViews++;
  return { ...statsData };
}

export function getLoaderCallCount(): number {
  return ++loaderCallCount;
}

export function getFetchableLoaderCallCount(): number {
  return ++fetchableLoaderCallCount;
}

export function resetLoaderCallCounts(): void {
  loaderCallCount = 0;
  fetchableLoaderCallCount = 0;
}
