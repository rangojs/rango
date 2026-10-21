import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import { escapeRegExp } from "../../regex-escape.js";
import { SERVER_REFERENCES_MODULE_ID } from "../discovery/build-versions.js";
import { literalProperties } from "./stable-rsc-output.js";

const MODULE = SERVER_REFERENCES_MODULE_ID.slice(1);
const NULL_PROTOTYPE = "__proto__: null,";

/** plugin-rsc's resolved id of the server-reference map, and nothing else. */
const SERVER_REFERENCES_ID_FILTER = new RegExp(
  `^${escapeRegExp(SERVER_REFERENCES_MODULE_ID)}$`,
);

function unexpectedShape(found: string): Error {
  return new Error(
    `${MODULE}: expected \`export default { "<key>": async () => { ...; ` +
      `return { <exports> }; }, ... }\`, found ${found}. The installed ` +
      `@vitejs/plugin-rsc generates a server-reference map @rangojs/router ` +
      `cannot give a null prototype. Report it with the plugin-rsc version.`,
  );
}

function isNull(node: any): boolean {
  return node?.type === "Literal" && node.raw === "null";
}

/** Has a `__proto__: null` (or `"__proto__": null`) property. */
function hasNullPrototype(object: any): boolean {
  return object.properties.some(
    (property: any) =>
      property.type === "Property" &&
      !property.computed &&
      (property.key.name ?? property.key.value) === "__proto__" &&
      isNull(property.value),
  );
}

/**
 * What an entry's loader returns: an arrow's expression body, or the argument
 * of a block body's final return. Only declarations and expression statements
 * may precede that return, so it is the only one.
 */
function returnedValue(loader: any): any {
  if (
    loader?.type !== "ArrowFunctionExpression" &&
    loader?.type !== "FunctionExpression"
  ) {
    return undefined;
  }
  if (loader.body.type !== "BlockStatement") return loader.body;
  const statements: any[] = loader.body.body;
  const last = statements.at(-1);
  const leadsToReturn = statements
    .slice(0, -1)
    .every(
      (statement) =>
        statement.type === "VariableDeclaration" ||
        statement.type === "ExpressionStatement",
    );
  return last?.type === "ReturnStatement" && leadsToReturn
    ? last.argument
    : undefined;
}

/** `import(id)`, awaited or not: a module namespace, which has no prototype. */
function isNamespace(node: any): boolean {
  const value = node?.type === "AwaitExpression" ? node.argument : node;
  return value?.type === "ImportExpression";
}

/**
 * Return plugin-rsc's server-reference map with `__proto__: null` in the map
 * and in each object an entry returns, or undefined when every level already
 * has a null prototype (or is a bare `import()`). Throws on any other shape.
 */
export function nullPrototypeServerReferences(
  code: string,
): string | undefined {
  let program: any;
  try {
    program = parseAst(code);
  } catch {
    throw unexpectedShape("a module that does not parse");
  }
  const map = program.body.find(
    (node: any) => node.type === "ExportDefaultDeclaration",
  )?.declaration;
  const entries = literalProperties(map);
  if (!entries)
    throw unexpectedShape("no default-exported object literal of plain keys");
  const output = new MagicString(code);
  if (!hasNullPrototype(map)) output.appendLeft(map.start + 1, NULL_PROTOTYPE);
  for (const entry of entries) {
    if (entry.key === "__proto__" && isNull(entry.value)) continue;
    const returned = returnedValue(entry.value);
    if (returned?.type === "ObjectExpression") {
      if (!hasNullPrototype(returned)) {
        output.appendLeft(returned.start + 1, NULL_PROTOTYPE);
      }
    } else if (!isNamespace(returned)) {
      throw unexpectedShape(
        `entry ${JSON.stringify(entry.key)} = \`${code.slice(entry.value.start, entry.value.end)}\``,
      );
    }
  }
  return output.hasChanged() ? output.toString() : undefined;
}

/**
 * An action id `<key>#<name>` resolves as `serverReferences[key]`, then the
 * entry's `[name]`; plugin-rsc builds both from plain object literals, so
 * `<key>#constructor` or `toString#constructor` resolved to a built-in.
 * - The map level guards every path: loadServerAction, decodeAction /
 *   decodeFormState and decodeReply all index `serverReferences[key]`.
 * - The entry level guards loadServerAction; React's decoders check
 *   `hasOwnProperty` for the name themselves.
 * Dev has no map: each module resolves to its namespace, which has no prototype.
 *
 * Runs in the normal phase, before plugin-rsc's `rsc:scan-strip` and
 * stable-rsc-output.ts's sort (both `post`). An RSC build that never loads the
 * module fails, so a renamed id cannot skip the rewrite.
 * @internal
 */
export function serverReferencesNullPrototype(): Plugin {
  let seen = false;
  return {
    name: "@rangojs/router:server-references-null-prototype",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "rsc",
    buildStart() {
      seen = false;
    },
    transform: {
      filter: { id: SERVER_REFERENCES_ID_FILTER },
      handler(code) {
        seen = true;
        const rewritten = nullPrototypeServerReferences(code);
        return rewritten === undefined ? null : { code: rewritten, map: null };
      },
    },
    buildEnd(error) {
      if (error || seen) return;
      throw new Error(
        `The RSC build never loaded ${MODULE}: expected @vitejs/plugin-rsc's ` +
          `server-reference map under that id, which @rangojs/router gives a ` +
          `null prototype so an action id cannot resolve an inherited name. ` +
          `Report it with the plugin-rsc version.`,
      );
    },
  };
}
