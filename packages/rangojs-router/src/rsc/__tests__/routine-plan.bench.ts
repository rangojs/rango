import { bench, describe } from "vitest";
import {
  createRoutineTrace,
  handoff,
  runRoutine,
  scope,
  step,
  type RoutinePlan,
} from "../routine-plan.js";

/**
 * Isolated driver overhead: the same six-effect request spine (shell gates,
 * match, payload, render flight+response, capture handoff) written as direct
 * awaits vs driven through runRoutine, so React/render noise cannot hide
 * the orchestration cost. Mirrors the shape of requestRenderPlan in
 * rsc-rendering.ts.
 */

const settled = Promise.resolve("value");

function effectSync(): string {
  return "value";
}

function effectAsync(): Promise<string> {
  return settled;
}

async function directBaseline(): Promise<string> {
  const shell = effectSync();
  const match = await effectAsync();
  const payload = effectSync();
  const flight = await effectAsync();
  const response = effectSync();
  void effectAsync();
  return shell + match + payload + flight + response;
}

function* renderPlan(): RoutinePlan<string> {
  const flight = yield* step("flight", effectAsync);
  const response = yield* step("response", effectSync);
  return flight + response;
}

function* spinePlan(): RoutinePlan<string> {
  const shell = yield* step("shell-serve", effectSync);
  const match = yield* step("match", effectAsync);
  const payload = yield* step("payload", effectSync);
  const rendered = yield* scope("render", renderPlan());
  yield* handoff("capture", effectAsync);
  return shell + match + payload + rendered;
}

describe("routine-plan runner overhead (six-effect request spine)", () => {
  bench("direct await sequence baseline", async () => {
    await directBaseline();
  });

  bench("runRoutine, trace off", async () => {
    await runRoutine(spinePlan());
  });

  bench("runRoutine, trace on", async () => {
    await runRoutine(spinePlan(), { trace: createRoutineTrace("bench") });
  });
});
