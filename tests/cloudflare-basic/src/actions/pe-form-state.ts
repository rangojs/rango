"use server";

export type TokenState = { token?: string } | null;
export type OpaqueState = { label: string } | null;

/** A value shown once: a fresh token no later render can reproduce. */
export async function makeToken(
  _prev: TokenState,
  _form: FormData,
): Promise<TokenState> {
  return { token: `tok-${crypto.randomUUID()}` };
}

class Opaque {
  constructor(readonly label: string) {}
}

/** A result Flight cannot serialize: a class instance. */
export async function makeOpaque(
  _prev: OpaqueState,
  _form: FormData,
): Promise<OpaqueState> {
  return new Opaque("opaque-result");
}
