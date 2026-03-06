import { describe, it, expect, beforeEach } from "vitest";
import {
  createVar,
  contextGet,
  contextSet,
  isStableVar,
  markStableVar,
  isFreshInCurrentPass,
  resetPassFreshness,
  _resetStableVars,
} from "../context-var.js";

describe("W2: pass-scoped freshness tracking", () => {
  beforeEach(() => {
    _resetStableVars();
  });

  // --- Freshness tracking ---

  it("variables are fresh when no pass boundary has been crossed", () => {
    const variables: Record<string | symbol, unknown> = {};
    contextSet(variables, "user", "alice");

    expect(isFreshInCurrentPass(variables, "user")).toBe(true);
  });

  it("variables set before resetPassFreshness are stale after reset", () => {
    const variables: Record<string | symbol, unknown> = {};
    contextSet(variables, "user", "alice");

    resetPassFreshness(variables);

    expect(isFreshInCurrentPass(variables, "user")).toBe(false);
    // Value is still there, just not fresh
    expect(contextGet(variables, "user")).toBe("alice");
  });

  it("variables set after resetPassFreshness are fresh", () => {
    const variables: Record<string | symbol, unknown> = {};
    contextSet(variables, "user", "alice");

    resetPassFreshness(variables);
    contextSet(variables, "user", "bob");

    expect(isFreshInCurrentPass(variables, "user")).toBe(true);
    expect(contextGet(variables, "user")).toBe("bob");
  });

  it("tracks freshness for ContextVar tokens (symbol keys)", () => {
    const Token = createVar<string>();
    const variables: Record<string | symbol, unknown> = {};

    contextSet(variables, Token, "value");
    expect(isFreshInCurrentPass(variables, Token)).toBe(true);

    resetPassFreshness(variables);
    expect(isFreshInCurrentPass(variables, Token)).toBe(false);

    contextSet(variables, Token, "refreshed");
    expect(isFreshInCurrentPass(variables, Token)).toBe(true);
  });

  it("tracks freshness independently per key", () => {
    const variables: Record<string | symbol, unknown> = {};
    contextSet(variables, "a", 1);
    contextSet(variables, "b", 2);

    resetPassFreshness(variables);
    contextSet(variables, "a", 10);

    expect(isFreshInCurrentPass(variables, "a")).toBe(true);
    expect(isFreshInCurrentPass(variables, "b")).toBe(false);
  });

  it("unset variables report fresh (no freshness set = first pass)", () => {
    const variables: Record<string | symbol, unknown> = {};
    // No contextSet call, no freshness set created
    expect(isFreshInCurrentPass(variables, "missing")).toBe(true);
  });

  // --- Stable vars (typed) ---

  it("createVar() without options is not stable", () => {
    const Token = createVar<string>();
    expect(isStableVar(Token)).toBe(false);
  });

  it("createVar({ stable: true }) is stable", () => {
    const Token = createVar<string>({ stable: true });
    expect(isStableVar(Token)).toBe(true);
  });

  it("createVar({ stable: false }) is not stable", () => {
    const Token = createVar<string>({ stable: false });
    expect(isStableVar(Token)).toBe(false);
  });

  // --- Stable vars (string keys) ---

  it("string key is not stable by default", () => {
    expect(isStableVar("user")).toBe(false);
  });

  it("markStableVar makes a string key stable", () => {
    markStableVar("locale");
    expect(isStableVar("locale")).toBe(true);
  });

  it("markStableVar does not affect other keys", () => {
    markStableVar("locale");
    expect(isStableVar("user")).toBe(false);
  });

  it("_resetStableVars clears the stable set", () => {
    markStableVar("locale");
    _resetStableVars();
    expect(isStableVar("locale")).toBe(false);
  });

  // --- Normal GET render (no warning scenarios) ---

  it("first pass: all ctx.get reads are fresh (no false positives)", () => {
    const variables: Record<string | symbol, unknown> = {};
    const Token = createVar<string>();

    contextSet(variables, "user", "alice");
    contextSet(variables, Token, "typed-value");

    // No resetPassFreshness — this is a single-pass GET render
    expect(isFreshInCurrentPass(variables, "user")).toBe(true);
    expect(isFreshInCurrentPass(variables, Token)).toBe(true);
  });

  it("stable vars are always marked stable regardless of freshness", () => {
    const Token = createVar<string>({ stable: true });
    const variables: Record<string | symbol, unknown> = {};

    contextSet(variables, Token, "initial");
    resetPassFreshness(variables);

    // Value is stale in pass terms, but stable var — no warning needed
    expect(isFreshInCurrentPass(variables, Token)).toBe(false);
    expect(isStableVar(Token)).toBe(true);
  });

  it("stable string vars are always marked stable regardless of freshness", () => {
    markStableVar("locale");
    const variables: Record<string | symbol, unknown> = {};

    contextSet(variables, "locale", "en");
    resetPassFreshness(variables);

    // Value is stale in pass terms, but stable var — no warning needed
    expect(isFreshInCurrentPass(variables, "locale")).toBe(false);
    expect(isStableVar("locale")).toBe(true);
  });

  // --- Multiple pass boundaries ---

  it("supports multiple consecutive pass resets", () => {
    const variables: Record<string | symbol, unknown> = {};
    contextSet(variables, "a", 1);

    resetPassFreshness(variables);
    expect(isFreshInCurrentPass(variables, "a")).toBe(false);

    contextSet(variables, "a", 2);
    expect(isFreshInCurrentPass(variables, "a")).toBe(true);

    resetPassFreshness(variables);
    expect(isFreshInCurrentPass(variables, "a")).toBe(false);
  });
});
