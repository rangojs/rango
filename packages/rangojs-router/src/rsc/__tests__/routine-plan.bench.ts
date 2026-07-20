import { bench, describe } from "vitest";
import {
  createRoutineTrace,
  driveRoutinePlan,
  run,
  schedule,
  subplan,
  type RoutinePlan,
} from "../routine-plan.js";

/**
 * Isolated driver overhead: the same six-effect request spine (shell gates,
 * match, payload, render flight+response, capture handoff) written as direct
 * awaits vs driven through driveRoutinePlan, so React/render noise cannot hide
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
  const flight = yield* run("flight", effectAsync);
  const response = yield* run("response", effectSync);
  return flight + response;
}

function* spinePlan(): RoutinePlan<string> {
  const shell = yield* run("shell-serve", effectSync);
  const match = yield* run("match", effectAsync);
  const payload = yield* run("payload", effectSync);
  const rendered = yield* subplan("render", renderPlan());
  yield* schedule("capture", effectAsync);
  return shell + match + payload + rendered;
}

describe("routine-plan driver overhead (six-effect request spine)", () => {
  bench("direct await sequence baseline", async () => {
    await directBaseline();
  });

  bench("driveRoutinePlan, trace off", async () => {
    await driveRoutinePlan(spinePlan());
  });

  bench("driveRoutinePlan, trace on", async () => {
    await driveRoutinePlan(spinePlan(), { trace: createRoutineTrace() });
  });
});
