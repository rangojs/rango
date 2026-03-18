export interface BlogActionProbeEntry {
  count: number;
  lastMessage: string | null;
  lastSubmittedAt: string | null;
}

const probeStore = new Map<string, BlogActionProbeEntry>();

function getOrCreateEntry(slug: string): BlogActionProbeEntry {
  let entry = probeStore.get(slug);
  if (!entry) {
    entry = {
      count: 0,
      lastMessage: null,
      lastSubmittedAt: null,
    };
    probeStore.set(slug, entry);
  }
  return entry;
}

export function getBlogActionProbe(slug: string): BlogActionProbeEntry {
  const entry = getOrCreateEntry(slug);
  return { ...entry };
}

export function recordBlogActionProbe(
  slug: string,
  message: string,
): BlogActionProbeEntry {
  const entry = getOrCreateEntry(slug);
  entry.count += 1;
  entry.lastMessage = message;
  entry.lastSubmittedAt = new Date().toISOString();
  return { ...entry };
}
