"use server";

// shell-push-ownership.test.ts (#1182): an action that changes nothing. The
// page's loaders re-run after it, as after every action.
export async function shellPushMetaAction(): Promise<void> {}
