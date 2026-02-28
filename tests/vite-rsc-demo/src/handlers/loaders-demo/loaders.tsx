import type { ReactNode } from "react";
import { createLoader } from "@rangojs/router";
import {
  usersStore,
  notesStore,
  addNote,
  uploadedFilesStore,
  addUploadedFile,
  getStats,
  getLoaderCallCount,
  getFetchableLoaderCallCount,
  type User,
  type Stats,
  type Note,
  type UploadedFile,
} from "./data.js";

// Export types for use in components
export type { User, Stats, Note, UploadedFile };

/**
 * UsersLoader - Standard loader for SSR/navigation
 * Data is loaded during SSR and navigation, accessed via useLoader()
 *
 * Use case: Initial page data that should be available immediately
 */
export const UsersLoader = createLoader(async (_ctx) => {
  "use server";

  // Simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 300));

  const callCount = getLoaderCallCount();

  return {
    users: [...usersStore],
    loadedAt: new Date().toISOString(),
    callCount,
    source: "SSR/Navigation" as const,
  };
});

export type UsersLoaderData = {
  users: User[];
  loadedAt: string;
  callCount: number;
  source: "SSR/Navigation";
};

/**
 * StatsLoader - Fetchable loader for on-demand client fetching
 * Data is fetched via useFetchLoader() when the client needs it
 *
 * The third argument `true` makes this loader fetchable via GET requests.
 * The loader ID is hashed in production builds to avoid exposing file paths.
 *
 * Use case: Data that should be fetched on-demand, not during initial load
 */
export const StatsLoader = createLoader(
  async (_ctx) => {
    "use server";

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 500));

    const callCount = getFetchableLoaderCallCount();
    const stats = getStats();

    return {
      stats,
      loadedAt: new Date().toISOString(),
      callCount,
      source: "Client Fetch (GET)" as const,
    };
  },
  true, // Enable fetchable - this loader can be called via useFetchLoader()
);

export type StatsLoaderData = {
  stats: Stats;
  loadedAt: string;
  callCount: number;
  source: "Client Fetch (GET)";
};

/**
 * UserSearchLoader - Fetchable loader with parameters
 * Demonstrates passing params from client to server loader
 *
 * Use case: Search/filter functionality triggered by user interaction
 */
export const UserSearchLoader = createLoader(
  async (ctx) => {
    "use server";

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Get search query from params (passed from client via useFetchLoader)
    const query = (ctx.params.query as string) || "";
    const roleFilter = ctx.params.role as string | undefined;

    let results = [...usersStore];

    // Filter by query (name or email)
    if (query) {
      const lowerQuery = query.toLowerCase();
      results = results.filter(
        (user) =>
          user.name.toLowerCase().includes(lowerQuery) ||
          user.email.toLowerCase().includes(lowerQuery),
      );
    }

    // Filter by role
    if (roleFilter && roleFilter !== "all") {
      results = results.filter((user) => user.role === roleFilter);
    }

    return {
      results,
      query,
      roleFilter: roleFilter || "all",
      totalMatches: results.length,
      searchedAt: new Date().toISOString(),
    };
  },
  true, // Enable fetchable
);

export type UserSearchLoaderData = {
  results: User[];
  query: string;
  roleFilter: string;
  totalMatches: number;
  searchedAt: string;
};

export type RSCContentLoaderData = {
  content: ReactNode;
  style: string;
  count: number;
  renderedAt: string;
};

/**
 * RSCContentLoader - Fetchable loader that returns React Server Component content
 *
 * Demonstrates that loaders can return JSX/ReactNode, not just data.
 * The RSC protocol serializes React elements and streams them to the client.
 *
 * Use case: Server-rendered UI that should be fetched on-demand
 */
export const RSCContentLoader = createLoader<RSCContentLoaderData>(
  async (ctx): Promise<RSCContentLoaderData> => {
    "use server";

    // Simulate server-side data fetching
    await new Promise((resolve) => setTimeout(resolve, 800));

    const style = (ctx.params.style as string) || "default";
    const count = parseInt(ctx.params.count as string) || 3;

    // Filter users based on count
    const users = usersStore.slice(0, count);

    // Return server-rendered JSX based on style parameter
    const content: ReactNode =
      style === "cards" ? (
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          {users.map((user) => (
            <div
              key={user.id}
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                padding: "1rem",
                width: "200px",
                background:
                  user.role === "admin"
                    ? "linear-gradient(135deg, #fef3c7 0%, #fff 100%)"
                    : "#fff",
              }}
            >
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  background: "#3b82f6",
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  marginBottom: "0.5rem",
                }}
              >
                {user.name.charAt(0)}
              </div>
              <h4 style={{ margin: "0 0 0.25rem 0" }}>{user.name}</h4>
              <p style={{ margin: 0, fontSize: "0.875rem", color: "#6b7280" }}>
                {user.email}
              </p>
              <span
                style={{
                  display: "inline-block",
                  marginTop: "0.5rem",
                  padding: "0.125rem 0.5rem",
                  borderRadius: "9999px",
                  fontSize: "0.75rem",
                  background: user.role === "admin" ? "#fef3c7" : "#e5e7eb",
                  color: user.role === "admin" ? "#92400e" : "#374151",
                }}
              >
                {user.role}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {users.map((user) => (
            <li
              key={user.id}
              style={{
                padding: "0.75rem",
                borderBottom: "1px solid #e5e7eb",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: "#3b82f6",
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  fontSize: "0.875rem",
                }}
              >
                {user.name.charAt(0)}
              </div>
              <div>
                <strong>{user.name}</strong>
                <span style={{ color: "#6b7280", marginLeft: "0.5rem" }}>
                  ({user.role})
                </span>
              </div>
            </li>
          ))}
        </ul>
      );

    return {
      content,
      style,
      count,
      renderedAt: new Date().toISOString(),
    };
  },
  true, // Enable fetchable
);

/**
 * NotesLoader - Demonstrates loader as both GET and POST
 *
 * This loader serves dual purposes:
 * 1. GET request: Fetches all notes (used with useEffect on mount)
 * 2. POST request: Adds a new note when submitted via load() with POST
 *
 * The loader checks ctx.body to determine if it's handling a mutation.
 * This pattern allows a single loader to handle both reading and writing.
 *
 * Use case: Simple CRUD operations where read and write share the same endpoint
 */
export const NotesLoader = createLoader(
  async (ctx) => {
    "use server";

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check if this is a form submission (mutation)
    const noteText = ctx.formData?.get("note") as string | null;
    let addedNote: Note | null = null;

    if (noteText && noteText.trim()) {
      // This is a mutation - add the note
      addedNote = addNote(noteText.trim());
    }

    // Return current notes (whether we just added one or not)
    return {
      notes: [...notesStore],
      addedNote,
      fetchedAt: new Date().toISOString(),
    };
  },
  true, // Enable fetchable - allows both GET and form action
);

export type NotesLoaderData = {
  notes: Note[];
  addedNote: Note | null;
  fetchedAt: string;
};

/**
 * FileUploadLoader - Demonstrates file upload handling via load() with POST
 *
 * This loader handles file metadata uploads:
 * - GET request: Returns list of uploaded files
 * - POST request: Receives file metadata via ctx.body and returns updated list
 *
 * Note: This is a demo that stores file metadata only (not actual file contents).
 * In a real app, you'd save to disk, S3, or a database.
 *
 * Use case: Form-based mutations via load({ method: "POST", body })
 */
export const FileUploadLoader = createLoader(
  async (ctx) => {
    "use server";

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check if this is a file upload (POST with body)
    const body = ctx.body as
      | { fileName: string; fileSize: number; fileType?: string }
      | undefined;
    let uploadedFile: UploadedFile | null = null;

    if (body?.fileName && body.fileSize > 0) {
      uploadedFile = addUploadedFile({
        name: body.fileName,
        size: body.fileSize,
        type: body.fileType || "application/octet-stream",
      });
    }

    // Return current files list
    return {
      files: [...uploadedFilesStore],
      uploadedFile,
      fetchedAt: new Date().toISOString(),
    };
  },
  true, // Enable fetchable
);

export type FileUploadLoaderData = {
  files: UploadedFile[];
  uploadedFile: UploadedFile | null;
  fetchedAt: string;
};

/**
 * ChatStreamLoader - Demonstrates async iterator/streaming response
 *
 * Returns an async generator that yields words one at a time with delays,
 * simulating an AI chat response. The RSC protocol streams each yield
 * to the client, enabling real-time UI updates.
 *
 * Use case: AI chat interfaces, real-time data feeds, progressive content loading
 */
export const ChatStreamLoader = createLoader(
  async (ctx) => {
    "use server";

    const prompt =
      (ctx.params.prompt as string) || "Hello! How can I help you today?";

    // Simulated AI responses based on prompt keywords
    const responses: Record<string, string> = {
      hello:
        "Hello! I'm a demo AI assistant. I can help you understand how streaming works in RSC. Each word you see is being streamed from the server in real-time!",
      help: "I'd be happy to help! This demo shows how async iterators can be used to stream content from server to client. It's perfect for AI chat interfaces, live feeds, and progressive loading.",
      stream:
        "Streaming in RSC works by yielding values from an async generator. The RSC protocol serializes each yielded value and sends it to the client incrementally. This creates a smooth, real-time experience!",
      react:
        "React Server Components are amazing! They let you write server-side code that streams to the client. Combined with async iterators, you can build incredibly responsive UIs.",
      default:
        "This is a streaming response demo. Each word is sent from the server with a small delay to simulate an AI typing. Try different prompts like 'hello', 'help', 'stream', or 'react'!",
    };

    // Select response based on prompt keywords
    const lowerPrompt = prompt.toLowerCase();
    let responseText = responses.default;
    for (const [keyword, response] of Object.entries(responses)) {
      if (lowerPrompt.includes(keyword)) {
        responseText = response;
        break;
      }
    }

    const words = responseText.split(" ");

    // Create async generator that yields words with delay
    async function* streamWords() {
      for (let i = 0; i < words.length; i++) {
        // Variable delay: shorter for common words, longer for punctuation
        const word = words[i];
        const delay = word.match(/[.!?]$/) ? 400 : 150;
        await new Promise((resolve) => setTimeout(resolve, delay));
        yield word + (i < words.length - 1 ? " " : "");
      }
    }

    return {
      stream: streamWords(),
      prompt,
      totalWords: words.length,
      startedAt: new Date().toISOString(),
    };
  },
  true, // Enable fetchable
);

export type ChatStreamLoaderData = {
  stream: AsyncGenerator<string, void, unknown>;
  prompt: string;
  totalWords: number;
  startedAt: string;
};
