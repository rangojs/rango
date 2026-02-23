"use server";

export interface Comment {
  id: number;
  name: string;
  text: string;
  createdAt: string;
}

// In-memory comment store (in real app, use D1/KV)
const commentsBySlug = new Map<string, Comment[]>();
let nextId = 1;

export async function addComment(
  slug: string,
  name: string,
  text: string
): Promise<void> {
  const comments = commentsBySlug.get(slug) ?? [];
  comments.push({
    id: nextId++,
    name: name.trim(),
    text: text.trim(),
    createdAt: new Date().toISOString(),
  });
  commentsBySlug.set(slug, comments);
}

export async function getComments(slug: string): Promise<Comment[]> {
  return commentsBySlug.get(slug) ?? [];
}
