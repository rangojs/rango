"use server";

// held-handles.test.ts: the toggle is unrelated to the held loader (its
// revalidate() skips it); the target action reruns it.
export async function heldHandlesToggleAction(): Promise<void> {}

export async function heldHandlesTargetAction(): Promise<void> {}
