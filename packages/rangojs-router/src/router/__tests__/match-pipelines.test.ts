import { describe, it, expect } from "vitest";
import { compose, empty } from "../match-pipelines";
import type { GeneratorMiddleware } from "../match-middleware/cache-lookup";

// Helper to collect all values from an async generator
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

// Helper to create async generator from array
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe("match-pipelines", () => {
  describe("empty()", () => {
    it("should yield no items", async () => {
      const result = await collect(empty<number>());
      expect(result).toEqual([]);
    });

    it("should complete immediately", async () => {
      const gen = empty<string>();
      const { done } = await gen.next();
      expect(done).toBe(true);
    });
  });

  describe("compose()", () => {
    it("should return identity middleware when no middleware provided", async () => {
      const pipeline = compose<number>();
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([1, 2, 3]);
    });

    it("should return single middleware when one provided", async () => {
      const double: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n * 2;
        }
      };

      const pipeline = compose(double);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([2, 4, 6]);
    });

    it("should compose middleware in reverse order (rightmost runs first)", async () => {
      const order: string[] = [];

      const addA: GeneratorMiddleware<string> = async function* (source) {
        order.push("A-start");
        for await (const s of source) {
          yield s + "A";
        }
        order.push("A-end");
      };

      const addB: GeneratorMiddleware<string> = async function* (source) {
        order.push("B-start");
        for await (const s of source) {
          yield s + "B";
        }
        order.push("B-end");
      };

      const addC: GeneratorMiddleware<string> = async function* (source) {
        order.push("C-start");
        for await (const s of source) {
          yield s + "C";
        }
        order.push("C-end");
      };

      // compose(A, B, C) means C runs first (innermost), then B, then A (outermost)
      const pipeline = compose(addA, addB, addC);
      const source = fromArray(["x"]);
      const result = await collect(pipeline(source));

      // C transforms first: "x" -> "xC"
      // B transforms second: "xC" -> "xCB"
      // A transforms last: "xCB" -> "xCBA"
      expect(result).toEqual(["xCBA"]);
      expect(order).toEqual([
        "A-start",
        "B-start",
        "C-start",
        "C-end",
        "B-end",
        "A-end",
      ]);
    });

    it("should handle middleware that yields multiple items", async () => {
      const duplicate: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n;
          yield n;
        }
      };

      const pipeline = compose(duplicate);
      const source = fromArray([1, 2]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([1, 1, 2, 2]);
    });

    it("should handle middleware that filters items", async () => {
      const evensOnly: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          if (n % 2 === 0) {
            yield n;
          }
        }
      };

      const pipeline = compose(evensOnly);
      const source = fromArray([1, 2, 3, 4, 5]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([2, 4]);
    });

    it("should handle middleware that adds items at beginning", async () => {
      const prepend: GeneratorMiddleware<number> = async function* (source) {
        yield 0;
        yield* source;
      };

      const pipeline = compose(prepend);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([0, 1, 2, 3]);
    });

    it("should handle middleware that adds items at end", async () => {
      const append: GeneratorMiddleware<number> = async function* (source) {
        yield* source;
        yield 99;
      };

      const pipeline = compose(append);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([1, 2, 3, 99]);
    });

    it("should work with empty source", async () => {
      const double: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n * 2;
        }
      };

      const pipeline = compose(double);
      const source = fromArray<number>([]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([]);
    });

    it("should compose three middleware correctly", async () => {
      const add1: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n + 1;
        }
      };

      const multiply2: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n * 2;
        }
      };

      const add10: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n + 10;
        }
      };

      // compose(add1, multiply2, add10)(source)
      // Flow: source -> add10 -> multiply2 -> add1 -> output
      // 5 -> 15 -> 30 -> 31
      const pipeline = compose(add1, multiply2, add10);
      const source = fromArray([5]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([31]);
    });

    it("should handle async operations in middleware", async () => {
      const asyncDouble: GeneratorMiddleware<number> = async function* (
        source,
      ) {
        for await (const n of source) {
          await new Promise((r) => setTimeout(r, 1));
          yield n * 2;
        }
      };

      const pipeline = compose(asyncDouble);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([2, 4, 6]);
    });

    it("should propagate errors from source", async () => {
      const identity: GeneratorMiddleware<number> = async function* (source) {
        yield* source;
      };

      async function* errorSource(): AsyncGenerator<number> {
        yield 1;
        throw new Error("source error");
      }

      const pipeline = compose(identity);

      await expect(collect(pipeline(errorSource()))).rejects.toThrow(
        "source error",
      );
    });

    it("should propagate errors from middleware", async () => {
      const throwingMiddleware: GeneratorMiddleware<number> =
        // oxlint-disable-next-line require-yield -- intentional: tests error before first yield
        async function* () {
          throw new Error("middleware error");
        };

      const pipeline = compose(throwingMiddleware);
      const source = fromArray([1, 2, 3]);

      await expect(collect(pipeline(source))).rejects.toThrow(
        "middleware error",
      );
    });

    it("should handle middleware that conditionally yields based on source", async () => {
      let sourceWasEmpty = true;

      const checkEmpty: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          sourceWasEmpty = false;
          yield n;
        }
        if (sourceWasEmpty) {
          yield -1; // Sentinel value for empty source
        }
      };

      const pipeline = compose(checkEmpty);

      // Test with non-empty source
      sourceWasEmpty = true;
      const result1 = await collect(pipeline(fromArray([1, 2])));
      expect(result1).toEqual([1, 2]);

      // Test with empty source
      sourceWasEmpty = true;
      const result2 = await collect(pipeline(fromArray([])));
      expect(result2).toEqual([-1]);
    });
  });

  describe("compose() edge cases", () => {
    it("should handle middleware that does not consume source (early return)", async () => {
      const earlyReturn: GeneratorMiddleware<number> = async function* () {
        yield 42;
        // Does not iterate source at all
      };

      const pipeline = compose(earlyReturn);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([42]);
    });

    it("should handle middleware that yields before consuming source", async () => {
      const yieldFirst: GeneratorMiddleware<number> = async function* (source) {
        yield 0; // Yield before consuming
        for await (const n of source) {
          yield n;
        }
      };

      const pipeline = compose(yieldFirst);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([0, 1, 2, 3]);
    });

    it("should handle middleware that yields both before and after source", async () => {
      const wrap: GeneratorMiddleware<number> = async function* (source) {
        yield -1; // Before
        for await (const n of source) {
          yield n;
        }
        yield 99; // After
      };

      const pipeline = compose(wrap);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([-1, 1, 2, 3, 99]);
    });

    it("should handle error thrown partway through source iteration", async () => {
      let count = 0;
      const countAndPass: GeneratorMiddleware<number> = async function* (
        source,
      ) {
        for await (const n of source) {
          count++;
          yield n;
        }
      };

      async function* partialErrorSource(): AsyncGenerator<number> {
        yield 1;
        yield 2;
        throw new Error("error after 2 items");
      }

      const pipeline = compose(countAndPass);

      await expect(collect(pipeline(partialErrorSource()))).rejects.toThrow(
        "error after 2 items",
      );
      expect(count).toBe(2); // Should have processed 2 items before error
    });

    it("should handle long middleware chains (10 middleware)", async () => {
      const makeAdder = (n: number): GeneratorMiddleware<number> =>
        async function* (source) {
          for await (const x of source) {
            yield x + n;
          }
        };

      // Create chain of 10 middleware, each adding 1
      const middleware = Array.from({ length: 10 }, () => makeAdder(1));
      const pipeline = compose(...middleware);

      const source = fromArray([0]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([10]); // 0 + 1*10 = 10
    });

    it("should handle middleware that accumulates state across iterations", async () => {
      const runningSum: GeneratorMiddleware<number> = async function* (source) {
        let sum = 0;
        for await (const n of source) {
          sum += n;
          yield sum;
        }
      };

      const pipeline = compose(runningSum);
      const source = fromArray([1, 2, 3, 4]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([1, 3, 6, 10]); // Running sums
    });

    it("should handle middleware that batches items", async () => {
      const batchBy2: GeneratorMiddleware<number> = async function* (source) {
        let batch: number[] = [];
        for await (const n of source) {
          batch.push(n);
          if (batch.length === 2) {
            yield batch.reduce((a, b) => a + b, 0); // Yield sum of batch
            batch = [];
          }
        }
        if (batch.length > 0) {
          yield batch.reduce((a, b) => a + b, 0); // Yield remaining
        }
      };

      const pipeline = compose(batchBy2);

      // Even number of items
      const result1 = await collect(pipeline(fromArray([1, 2, 3, 4])));
      expect(result1).toEqual([3, 7]); // (1+2), (3+4)

      // Odd number of items
      const result2 = await collect(pipeline(fromArray([1, 2, 3])));
      expect(result2).toEqual([3, 3]); // (1+2), (3)
    });

    it("should handle middleware that skips first N items", async () => {
      const skipFirst2: GeneratorMiddleware<number> = async function* (source) {
        let count = 0;
        for await (const n of source) {
          if (count >= 2) {
            yield n;
          }
          count++;
        }
      };

      const pipeline = compose(skipFirst2);
      const source = fromArray([1, 2, 3, 4, 5]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([3, 4, 5]);
    });

    it("should handle middleware that takes first N items only", async () => {
      const takeFirst2: GeneratorMiddleware<number> = async function* (source) {
        let count = 0;
        for await (const n of source) {
          if (count >= 2) break;
          yield n;
          count++;
        }
      };

      const pipeline = compose(takeFirst2);
      const source = fromArray([1, 2, 3, 4, 5]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([1, 2]);
    });

    it("should handle composed middleware where inner produces more than outer consumes", async () => {
      const duplicate: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n;
          yield n;
        }
      };

      const takeFirst3: GeneratorMiddleware<number> = async function* (source) {
        let count = 0;
        for await (const n of source) {
          if (count >= 3) break;
          yield n;
          count++;
        }
      };

      // takeFirst3 is outer (runs last), duplicate is inner (runs first)
      const pipeline = compose(takeFirst3, duplicate);
      const source = fromArray([1, 2, 3]);
      const result = await collect(pipeline(source));

      // duplicate produces: 1, 1, 2, 2, 3, 3
      // takeFirst3 takes: 1, 1, 2
      expect(result).toEqual([1, 1, 2]);
    });

    it("should handle middleware with async delays between yields", async () => {
      const delayedYield: GeneratorMiddleware<number> = async function* (
        source,
      ) {
        for await (const n of source) {
          await new Promise((r) => setTimeout(r, 5));
          yield n * 2;
          await new Promise((r) => setTimeout(r, 5));
        }
      };

      const pipeline = compose(delayedYield);
      const source = fromArray([1, 2]);
      const result = await collect(pipeline(source));

      expect(result).toEqual([2, 4]);
    });

    it("should handle middleware that transforms type", async () => {
      // Note: This tests type transformation within the same generic constraint
      const stringify: GeneratorMiddleware<number | string> = async function* (
        source,
      ) {
        for await (const n of source) {
          yield `num:${n}`;
        }
      };

      const pipeline = compose(stringify);
      const source = fromArray([1, 2, 3] as (number | string)[]);
      const result = await collect(pipeline(source));

      expect(result).toEqual(["num:1", "num:2", "num:3"]);
    });

    it("should handle re-using the same composed pipeline multiple times", async () => {
      const double: GeneratorMiddleware<number> = async function* (source) {
        for await (const n of source) {
          yield n * 2;
        }
      };

      const pipeline = compose(double);

      // Use the same pipeline multiple times
      const result1 = await collect(pipeline(fromArray([1, 2])));
      const result2 = await collect(pipeline(fromArray([3, 4])));
      const result3 = await collect(pipeline(fromArray([5])));

      expect(result1).toEqual([2, 4]);
      expect(result2).toEqual([6, 8]);
      expect(result3).toEqual([10]);
    });
  });
});
