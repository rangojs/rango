"use server";

/**
 * Distinct module-level actions for the clientUrls isAction() e2e. Isolated
 * so `import * as ClientUrlsIsActions` is a clean namespace of just these two
 * — the target-gated loader matches only the target; the namespace-gated
 * loader matches either.
 */
export async function clientUrlsTargetAction(): Promise<void> {}

export async function clientUrlsDecoyAction(): Promise<void> {}
