// Items a delete action removed, per run (action-failure.test.ts). Server
// only: the actions and the item loader import it, never a client module.
const deletedItems = new Set<string>();

export function deleteActionFailureItem(run: string, id: string): void {
  deletedItems.add(`${run}:${id}`);
}

export function isActionFailureItemDeleted(run: string, id: string): boolean {
  return deletedItems.has(`${run}:${id}`);
}
