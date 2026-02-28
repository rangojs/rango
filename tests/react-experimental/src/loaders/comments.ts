import { createLoader } from "@rangojs/router";

export interface Comment {
  id: number;
  name: string;
  text: string;
  createdAt: string;
}

// In-memory comment store (in real app, use D1/KV)
const commentsBySlug = new Map<string, Comment[]>();
let nextId = 1;

export const CommentsLoader = createLoader(async (ctx) => {
  "use server";

  const slug = ctx.params.slug as string;

  // Handle POST mutation (JSON body from load({ method: "POST", body: {...} }))
  const body = ctx.body as { name?: string; text?: string } | undefined;
  const name = body?.name ?? null;
  const text = body?.text ?? null;

  if (name?.trim() && text?.trim()) {
    const comments = commentsBySlug.get(slug) ?? [];
    comments.push({
      id: nextId++,
      name: name.trim(),
      text: text.trim(),
      createdAt: new Date().toISOString(),
    });
    commentsBySlug.set(slug, comments);
  }

  // Always return current comments
  return commentsBySlug.get(slug) ?? [];
}, true);
