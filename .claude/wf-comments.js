export const meta = {
  name: "rango-comment-reduction",
  description:
    "Haiku mass agents: strip redundant comments, keep load-bearing ones (code-as-doc)",
  phases: [
    { title: "Reduce", detail: "one haiku agent per disjoint file group" },
  ],
};

const ROOT = "/Users/ivotodorov/Development/vite-rsc-2";
const GROUPS_FILE = `${ROOT}/.claude/comment-groups.json`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    group: { type: "string" },
    filesEdited: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          removed: {
            type: "number",
            description: "Approx count of comment lines removed.",
          },
          note: { type: "string" },
        },
        required: ["file", "removed"],
      },
    },
    untouched: {
      type: "array",
      items: { type: "string" },
      description: "Files left fully as-is.",
    },
    notes: { type: "string" },
  },
  required: ["group", "filesEdited", "untouched", "notes"],
};

function prompt(group) {
  return `You reduce comment NOISE in one slice of @rangojs/router so the code reads as its own documentation, keeping only comments that genuinely earn their place.

REPO ROOT: ${ROOT}
YOUR FILES: open ${GROUPS_FILE} (JSON array), find the entry where "group" === "${group}", and edit ONLY the files in its "files" array. Never touch any file outside that list.

GOAL: code-is-the-doc. Remove comments that add ZERO information beyond the code; keep comments that capture intent a reader cannot recover from the code alone.

REMOVE (these are noise):
- Comments that restate the next line ("// increment i", "// loop over products", "// return the result", "// set the flag").
- Redundant section/banner comments and decorative separators that only label obvious structure.
- Commented-out dead code.
- Obvious restatements of a parameter, type, or signature already visible.
- Verbose step-by-step narration of self-evident logic.

KEEP (never remove — this repo deliberately values these):
- Comments explaining WHY: rationale, trade-offs, why a non-obvious approach was chosen.
- Non-obvious invariants and gotchas / "scar tissue" ("this started as a bug", "do NOT X because Y", "must run before Z").
- Behavior not evident from the code (ordering guarantees, edge cases, platform quirks).
- References to issues/PRs/specs/RFCs, and links to other modules.
- JSDoc on EXPORTED functions/types/classes/consts (public API surface) and file-header doc comments that orient the reader.
- Anything describing a subtle contract (cache scope, handler-first ordering, dev/prod parity, bundle hygiene).

NEVER TOUCH (not removable; removing them changes behavior or tooling):
- Directive comments: \`@ts-expect-error\`, \`@ts-ignore\`, \`eslint-disable*\`, \`oxlint-disable*\`, \`biome-ignore\`, \`prettier-ignore\`, \`@__PURE__\`, \`c8 ignore\`, \`v8 ignore\`, \`istanbul ignore\`, and any \`@\`-prefixed pragma.
- String directives \`"use client"\`, \`"use server"\`, \`"use cache"\` — these are STRINGS, not comments. Do not touch.
- License/copyright headers. Type annotations. Any code, string literal, or import.

RULES:
- Edit comments ONLY. Never change a line of code, a string, whitespace inside code, or imports. Removing a comment must not change runtime, types, or lint.
- When in doubt, KEEP. Bias hard toward keeping. It is better to leave a borderline comment than to delete a load-bearing one.
- No emoji/icons in any comment you leave (repo rule). Do not ADD comments.
- Remove the comment line(s) cleanly; if removal leaves a doubled blank line, collapse it, but do not reflow code.

Set group="${group}". Report filesEdited (with approx removed count + a short note), untouched files, and any notes.`;
}

// 19 disjoint groups (g1..g19) from gen-comment-groups.cjs. Each agent reads
// its own file list out of GROUPS_FILE (scripts can't touch the filesystem).
const GROUP_NAMES = Array.from({ length: 19 }, (_, i) => `g${i + 1}`);

log(
  `Comment reduction: ${GROUP_NAMES.length} haiku agents over disjoint file groups (code-as-doc, conservative).`,
);

const results = await parallel(
  GROUP_NAMES.map(
    (name) => () =>
      agent(prompt(name), {
        label: `comments:${name}`,
        phase: "Reduce",
        schema: SCHEMA,
        model: "haiku",
      }),
  ),
);

return { results: results.filter(Boolean) };
