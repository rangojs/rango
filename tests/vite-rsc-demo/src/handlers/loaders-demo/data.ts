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

// Quick notes store for demonstrating loader as GET + action
export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

export const notesStore: Note[] = [
  {
    id: "1",
    text: "Remember to review the PR",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "2",
    text: "Check loader documentation",
    createdAt: new Date(Date.now() - 1800000).toISOString(),
  },
];

export function addNote(text: string): Note {
  const note: Note = {
    id: String(Date.now()),
    text,
    createdAt: new Date().toISOString(),
  };
  notesStore.unshift(note);
  return note;
}

export function deleteNote(id: string): boolean {
  const index = notesStore.findIndex((n) => n.id === id);
  if (index !== -1) {
    notesStore.splice(index, 1);
    return true;
  }
  return false;
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

// File upload store (in-memory, simulates file storage)
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
}

export const uploadedFilesStore: UploadedFile[] = [];

export function addUploadedFile(file: {
  name: string;
  size: number;
  type: string;
}): UploadedFile {
  const uploaded: UploadedFile = {
    id: String(Date.now()),
    name: file.name,
    size: file.size,
    type: file.type,
    uploadedAt: new Date().toISOString(),
  };
  uploadedFilesStore.unshift(uploaded);
  return uploaded;
}

export function clearUploadedFiles(): void {
  uploadedFilesStore.length = 0;
}
