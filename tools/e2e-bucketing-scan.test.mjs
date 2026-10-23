import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REPO_ROOT,
  bucketingViolations,
  helperDefinitionViolations,
  helperDefinitions,
  scanSource,
  splitSuites,
} from "./lib/e2e-bucketing-scan.mjs";

// The two production greps in use: rangojs-router and cloudflare-basic.
const ROUTER_GREP = /\(production/;
const CF_GREP = /\(production\)/;

const scan = (src, grep = ROUTER_GREP) => scanSource("x.test.ts", src, grep);
const violations = (src, grep) => bucketingViolations(scan(src, grep));
const problemOf = (src) => {
  const v = violations(src);
  assert.equal(v.length, 1, src);
  assert.equal(v[0].kind, "helper", src);
  return v[0].problem;
};
const fullPaths = (src) => scan(src).map((r) => r.fullPath);

const BOTH_MODES = `
export function bothModes(
  name: string,
  suite: (f: Fixture) => void,
  options: Omit<Parameters<typeof useFixture>[0], "mode">,
): void {
  test.describe(\`\${name} (dev)\`, () => {
    suite(useFixture({ ...options, mode: "dev" }));
  });
  test.describe(\`\${name} (production)\`, () => {
    suite(useFixture({ ...options, mode: "build" }));
  });
}
`;
const definitionProblems = (src, helper = "bothModes") =>
  helperDefinitions("fixture.ts", src, helper).problems.map((p) => p.problem);

test("the greps these tests use are the ones the configs declare", () => {
  const sources = new Set(splitSuites().map((s) => s.prodGrep.source));
  assert.ok(sources.size > 0);
  for (const source of sources) {
    assert.ok([ROUTER_GREP.source, CF_GREP.source].includes(source), source);
  }
});

test("a literal bothModes call expands to a dev and a production describe", () => {
  for (const grep of [ROUTER_GREP, CF_GREP]) {
    const records = scan(
      'bothModes("response-cache", responseCacheSuite, { root: "." });',
      grep,
    );
    assert.deepEqual(
      records.map((r) => [r.title, r.dev, r.build, r.taggedProd, r.via]),
      [
        ["response-cache (dev)", true, false, false, "bothModes"],
        ["response-cache (production)", false, true, true, "bothModes"],
      ],
    );
    assert.deepEqual(bucketingViolations(records), []);
  }
});

test("prodDescribe still expands to one production describe, computed name included", () => {
  for (const src of [
    'prodDescribe("shop", (f) => {});',
    "prodDescribe(name, (f) => {});",
  ]) {
    const records = scan(src, CF_GREP);
    assert.deepEqual(
      records.map((r) => [r.build, r.dev, r.taggedProd]),
      [[true, false, true]],
      src,
    );
    assert.deepEqual(bucketingViolations(records), [], src);
  }
});

test("a computed bothModes name fails the guard", () => {
  for (const src of [
    "bothModes(name, suite, { root: '.' });",
    "bothModes(`cache ${kind}`, suite, { root: '.' });",
    "bothModes('cache' + kind, suite, { root: '.' });",
  ]) {
    assert.match(problemOf(src), /string-literal name/);
  }
  assert.deepEqual(violations("bothModes(`cache`, suite, {});"), []);
});

test("a name the production grep matches puts the dev describe in the wrong bucket", () => {
  for (const name of ["cache (production)", "cache (production-like)"]) {
    const v = violations(`bothModes(${JSON.stringify(name)}, suite, {});`);
    assert.deepEqual(
      v.map((x) => [x.kind, x.title]),
      [["dev", `${name} (dev)`]],
    );
  }
});

test("an aliased import or a namespace call fails the guard", () => {
  assert.match(
    problemOf('import { bothModes as both } from "./fixture";'),
    /without an alias/,
  );
  assert.match(
    problemOf('fx.bothModes("cache", suite, {});'),
    /by its bare name/,
  );
  assert.deepEqual(
    violations('import { bothModes, type Fixture } from "./fixture";'),
    [],
  );
});

test("describes in a suite are recorded under both expansions, inline or named", () => {
  const expected = [
    "cache (dev)",
    "cache (dev) > inner",
    "cache (production)",
    "cache (production) > inner",
  ];
  assert.deepEqual(
    fullPaths(`
      bothModes("cache", (f) => {
        test.describe("inner", () => {});
      }, {});
    `),
    expected,
  );
  assert.deepEqual(
    fullPaths(
      'bothModes("cache", (f) => test.describe("inner", () => {}), {});',
    ),
    expected,
  );
  // A named suite is also visited where it is declared, outside the expansion.
  assert.deepEqual(
    fullPaths(`
      function cacheSuite(f) {
        test.describe("inner", () => {});
      }
      bothModes("cache", cacheSuite, {});
    `),
    ["inner", ...expected],
  );
});

test("a production-titled describe inside a bothModes suite fails in the dev expansion", () => {
  const v = violations(`
    const cacheSuite = (f) => {
      test.describe("edge (production)", () => {});
    };
    bothModes("cache", cacheSuite, {});
  `);
  assert.deepEqual(
    v.map((x) => [x.kind, x.title]),
    [["dev", "cache (dev) > edge (production)"]],
  );
});

test("a describe with its own fixture inside an expansion keeps its own mode", () => {
  const records = scan(`
    bothModes("cache", (f) => {
      test.describe("own", () => {
        const g = useFixture({ root: ".", mode: "dev" });
        test.describe("leaf", () => {});
      });
    }, {});
  `);
  const leaf = records.filter((r) => r.title === "leaf");
  assert.deepEqual(
    leaf.map((r) => [r.fullPath, r.dev, r.build]),
    [
      ["cache (dev) > own > leaf", true, false],
      ["cache (production) > own > leaf", true, false],
    ],
  );
});

test("a suite that registers itself is expanded one level deep", () => {
  assert.deepEqual(
    fullPaths(`
      function loop(f) {
        bothModes("again", loop, {});
      }
      bothModes("cache", loop, {});
    `),
    [
      "again (dev)",
      "again (dev) > again (dev)",
      "again (dev) > again (production)",
      "again (production)",
      "again (production) > again (dev)",
      "again (production) > again (production)",
      "cache (dev)",
      "cache (dev) > again (dev)",
      "cache (dev) > again (production)",
      "cache (production)",
      "cache (production) > again (dev)",
      "cache (production) > again (production)",
    ],
  );
});

test("a bothModes call does not give its enclosing describe a fixture", () => {
  const [outer] = scan(`
    test.describe("outer", () => {
      bothModes("cache", suite, { root: "." });
    });
  `);
  assert.equal(outer.title, "outer");
  assert.equal(outer.dev, false);
  assert.equal(outer.build, false);
});

test("the definitions the e2e suites import match the expansion", () => {
  for (const [file, helper] of [
    ["packages/rangojs-router/e2e/response-cache.test.ts", "bothModes"],
    ["tests/cloudflare-basic/e2e/response-cache.test.ts", "bothModes"],
    ["tests/vite-rsc-demo/e2e/todos.test.ts", "prodDescribe"],
  ]) {
    assert.deepEqual(
      helperDefinitionViolations(path.join(REPO_ROOT, file), [helper]),
      [],
      file,
    );
  }
  assert.deepEqual(definitionProblems(BOTH_MODES), []);
});

test("an arrow-function definition is checked too", () => {
  const src = `
    export const bothModes = (name, suite, options) => {
      test.describe(\`\${name} (dev)\`, () => suite(useFixture({ ...options, mode: "dev" })));
      test.describe(\`\${name} (prod)\`, () => suite(useFixture({ ...options, mode: "build" })));
    };
  `;
  assert.deepEqual(definitionProblems(src), [
    "a bothModes describe title must be `${name} (dev)` or `${name} (production)`",
    "bothModes must register exactly one (production) describe",
  ]);
});

test("a definition that tags production differently fails", () => {
  const src = BOTH_MODES.replace("(production)`", "(prod)`");
  assert.deepEqual(definitionProblems(src), [
    "a bothModes describe title must be `${name} (dev)` or `${name} (production)`",
    "bothModes must register exactly one (production) describe",
  ]);
});

test("a definition that swaps the fixture modes fails", () => {
  const src = BOTH_MODES.replace('mode: "dev"', 'mode: "tmp"')
    .replace('mode: "build"', 'mode: "dev"')
    .replace('mode: "tmp"', 'mode: "build"');
  assert.deepEqual(definitionProblems(src), [
    'the (dev) describe must wire useFixture({ mode: "dev" }) and no other mode',
    'the (production) describe must wire useFixture({ mode: "build" }) and no other mode',
  ]);
});

test("a definition with a computed fixture mode fails", () => {
  const src = BOTH_MODES.replace('mode: "build"', "mode: kind");
  assert.deepEqual(definitionProblems(src), [
    'the (production) describe must wire useFixture({ mode: "build" }) and no other mode',
  ]);
});

test("a definition that does not run the suite in a describe fails", () => {
  const src = BOTH_MODES.replace(
    'suite(useFixture({ ...options, mode: "build" }));',
    'useFixture({ ...options, mode: "build" });',
  );
  assert.deepEqual(definitionProblems(src), [
    "the (production) describe must call suite(...)",
  ]);
});

test("a definition that builds a title by concatenation fails", () => {
  const src = BOTH_MODES.replace("`${name} (dev)`", 'name + " (dev)"');
  assert.deepEqual(definitionProblems(src), [
    "a bothModes describe title must be `${name} (dev)` or `${name} (production)`",
    "bothModes must register exactly one (dev) describe",
  ]);
});

test("a definition that registers a mode twice fails", () => {
  const src = BOTH_MODES.replace(
    "): void {",
    '): void {\n  test.describe(`${name} (dev)`, () => suite(useFixture({ ...options, mode: "dev" })));',
  );
  assert.deepEqual(definitionProblems(src), [
    "bothModes must register exactly one (dev) describe",
  ]);
});

test("a prodDescribe definition is held to its single production describe", () => {
  const src = `
    export function prodDescribe(name, body, options = { root: "." }) {
      test.describe(\`\${name} (prod)\`, () => {
        const f = useFixture({ ...options, mode: "build" });
        body(f);
      });
    }
  `;
  assert.deepEqual(definitionProblems(src, "prodDescribe"), [
    "a prodDescribe describe title must be `${name} (production)`",
    "prodDescribe must register exactly one (production) describe",
  ]);
});

test("the definition is read from the module each caller imports", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-bucketing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  write("fixture.ts", BOTH_MODES.replace("(production)`", "(prod)`"));
  const call = 'bothModes("cache", suite, {});';
  const a = write(
    "a.test.ts",
    `import { bothModes } from "./fixture";\n${call}`,
  );
  const b = write(
    "b.test.ts",
    `import { bothModes } from "./fixture.js";\n${call}`,
  );
  const pkg = write(
    "c.test.ts",
    `import { bothModes } from "@shared/e2e";\n${call}`,
  );
  const none = write("d.test.ts", call);
  const local = write("e.test.ts", `${BOTH_MODES}\n${call}`);

  // A shared definition's problems are reported once, by its first caller.
  const cache = new Map();
  const first = helperDefinitionViolations(a, ["bothModes"], cache);
  assert.deepEqual(
    first.map((v) => [path.basename(v.file), v.problem]),
    [
      [
        "fixture.ts",
        "a bothModes describe title must be `${name} (dev)` or `${name} (production)`",
      ],
      [
        "fixture.ts",
        "bothModes must register exactly one (production) describe",
      ],
    ],
  );
  assert.deepEqual(helperDefinitionViolations(b, ["bothModes"], cache), []);

  assert.match(
    helperDefinitionViolations(pkg, ["bothModes"])[0].problem,
    /imported from "@shared\/e2e", which the guard cannot read/,
  );
  assert.match(
    helperDefinitionViolations(none, ["bothModes"])[0].problem,
    /neither defined nor imported/,
  );
  assert.deepEqual(helperDefinitionViolations(local, ["bothModes"]), []);
});
