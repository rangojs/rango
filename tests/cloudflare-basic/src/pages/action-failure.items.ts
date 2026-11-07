// Items a delete action removed, per run (e2e/action-failure.test.ts). Server
// only: the actions and the item loader import it, never a client module.
const deletedItems = new Set<string>();

export function deleteActionFailureItem(run: string, id: string): void {
  deletedItems.add(`${run}:${id}`);
}

export function isActionFailureItemDeleted(run: string, id: string): boolean {
  return deletedItems.has(`${run}:${id}`);
}

// Items an archive action took out of view, per run: the item loader then
// throws notFound().
const archivedItems = new Set<string>();

export function archiveActionFailureItem(run: string, id: string): void {
  archivedItems.add(`${run}:${id}`);
}

export function isActionFailureItemArchived(run: string, id: string): boolean {
  return archivedItems.has(`${run}:${id}`);
}
