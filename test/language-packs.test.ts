/**
 * Language packs: a language graft never heard of, loaded from `.graft/langs/<name>/`
 * in the repo or `~/.graft/langs/<name>/` at home, contributing exactly what a built-in
 * breadth row does — extensions, grammar, tags query, optionally an LSP server row.
 *
 * The fixture pack "moon" reuses the bundled Lua grammar and graft's own lua.scm under
 * a new name and extension, so the tests prove the pack plumbing (discovery, registry,
 * walk, `-e` validation, LSP pick) without needing a grammar of their own — and prove
 * the refusals: a pack can add a language, never take one away.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadLanguagePacks, packDirs, resetLanguagePacksForTest } from "../src/graph/packs.js";
import { extractGeneric, genericLangOf, resetGenericLangsForTest, swapGrammarForTest, warmGenericGrammars } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";
import { pickServer, resetLspServersForTest } from "../src/graph/lsp/registry.js";
import { buildGraph } from "../src/graph/build.js";
import { buildRepoMap } from "../src/graph/map.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";

const require = createRequire(import.meta.url);
const LUA_WASM = require.resolve("tree-sitter-wasm/lua/tree-sitter-lua.wasm");
const LUA_TAGS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "graph", "queries", "lua.scm");
const LUA_SRC = "local function helper()\n  return 1\nend\n\nlocal function run()\n  return helper()\nend\n";

/** Write a pack dir: manifest + (by default) the Lua grammar and query under the pack's name. */
function writePack(base: string, name: string, manifest: object, files: { grammar?: boolean; tags?: boolean } = {}): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (files.grammar !== false) copyFileSync(LUA_WASM, join(dir, `tree-sitter-${name}.wasm`));
  if (files.tags !== false) copyFileSync(LUA_TAGS, join(dir, "tags.scm"));
  writeFileSync(join(dir, "pack.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return dir;
}
const manifest = (name: string, ext: string, extra: object = {}) =>
  ({ name, extensions: [ext], grammar: `tree-sitter-${name}.wasm`, tags: "tags.scm", ...extra });
const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `graft-packs-${tag}-`));
/** A repo with its pack dir, and an empty home so the developer's own packs stay out. */
function repoAndHome(): { repo: string; home: string; langs: string } {
  const repo = tmp("repo"), home = tmp("home");
  const langs = packDirs(repo, home)[0];
  mkdirSync(langs, { recursive: true });
  return { repo, home, langs };
}

beforeEach(() => {
  resetLanguagePacksForTest();
  resetGenericLangsForTest();
  resetLspServersForTest();
  for (const n of ["moon", "sun", "star"]) swapGrammarForTest(n, null);
});

test("a repo-level pack adds a language: discovery, extension routing, -e validation, a built graph", async () => {
  const { repo, home, langs } = repoAndHome();
  writePack(langs, "moon", manifest("moon", ".moon"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.moon"), LUA_SRC);

  const warnings: string[] = [];
  const r = loadLanguagePacks(repo, { home, warn: (m) => warnings.push(m) });
  assert.deepEqual(r, { loaded: ["moon"], skipped: [] });
  assert.deepEqual(warnings, []);
  assert.equal(genericLangOf("src/a.moon")?.name, "moon", "the pack's extension routes to the pack");
  assert.equal(genericLangOf("src/a.moon")?.wasmPath, join(langs, "moon", "tree-sitter-moon.wasm"));
  assert.ok(supportedExtensions().includes(".moon"), "-e knows the pack's extension");
  assert.deepEqual(unsupportedExtensions([".moon", ".nope"], repo), [".nope"]);

  // The build's own walk loads packs too (idempotently — no second warning), and the
  // pack's files come out as breadth-tier nodes with resolved calls.
  await buildGraph(repo, { reuse: false });
  const g = readGraph(wiringPath(contextDirFor(repo)));
  const defs = g!.nodes.filter((n) => n.path === "src/a.moon" && n.kind !== "file");
  assert.deepEqual(defs.map((n) => `${n.kind}:${n.name}`).sort(), ["function:helper", "function:run"]);
  assert.ok(defs.every((n) => n.origin === "generic"));
  assert.ok(g!.edges.some((e) => e.relation === "calls" && e.source === "src/a.moon#run" && e.target === "src/a.moon#helper"), "run → helper resolved");
  assert.ok(g!.meta.languages.includes("moon"), `banner lists the pack language (got ${g!.meta.languages.join(", ")})`);

  // `graft map` runs in its own process: it loads the packs itself before reading
  // the graph, or its header could not name a pack language (`.moon` would route
  // nowhere). The CLI does exactly this sequence.
  resetLanguagePacksForTest(); resetGenericLangsForTest(); resetLspServersForTest();
  loadLanguagePacks(repo, { home, warn: (m) => assert.fail(m) });
  const header = buildRepoMap(g!, { maxDirs: 5 }).totals.languages;
  assert.ok(header.includes("moon"), `map header names the pack language (got ${header.join(", ")})`);
});

test("a pack can add a language but never take one away: every refusal is one warning, nothing else changes", () => {
  const { repo, home, langs } = repoAndHome();
  writePack(langs, "a_builtin_ext", manifest("a_builtin_ext", ".lua")); // breadth tier owns .lua
  writePack(langs, "a_depth_ext", manifest("a_depth_ext", ".ts")); // depth tier owns .ts
  writePack(langs, "rust", manifest("rust", ".rsx")); // a built-in name
  writePack(langs, "no_grammar", manifest("no_grammar", ".ng"), { grammar: false });
  writePack(langs, "no_tags", manifest("no_tags", ".nt"), { tags: false });
  writePack(langs, "bad_json", "{ not json", {});
  writePack(langs, "Bad-Name", manifest("Bad-Name", ".bn"));
  writePack(langs, "bad_lsp", manifest("bad_lsp", ".bl", { lsp: { args: [] } }));

  const warnings: string[] = [];
  const r = loadLanguagePacks(repo, { home, warn: (m) => warnings.push(m) });
  assert.deepEqual(r.loaded, []);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.dir.split("/").pop(), s.reason]));
  assert.match(reasons.a_builtin_ext, /\.lua is already indexed as lua/);
  assert.match(reasons.a_depth_ext, /\.ts is already indexed as typescript/);
  assert.match(reasons.rust, /built-in language/);
  assert.match(reasons.no_grammar, /grammar not found/);
  assert.match(reasons.no_tags, /tags query not found/);
  assert.match(reasons.bad_json, /not valid JSON/);
  assert.match(reasons["Bad-Name"], /"name" must match/);
  assert.match(reasons.bad_lsp, /"lsp" must be/);
  assert.equal(warnings.length, r.skipped.length, "exactly one stderr line per refused pack");
  // and the built-ins are exactly as they were
  assert.equal(genericLangOf("x.lua")?.name, "lua");
  assert.equal(genericLangOf("x.rsx"), null);
  assert.equal(genericLangOf("x.ng"), null);
});

test("a home-level pack applies to every repo; a repo-level pack of the same name wins", () => {
  const { repo, home, langs } = repoAndHome();
  const homeLangs = packDirs(repo, home)[1];
  writePack(homeLangs, "star", manifest("star", ".star")); // home only
  writePack(homeLangs, "sun", manifest("sun", ".sun_home")); // both — the repo's copy must win
  writePack(langs, "sun", manifest("sun", ".sun"));

  const warnings: string[] = [];
  const r = loadLanguagePacks(repo, { home, warn: (m) => warnings.push(m) });
  assert.deepEqual(r, { loaded: ["sun", "star"], skipped: [] }, "repo packs first, then home; the shadowed home copy is not a refusal");
  assert.deepEqual(warnings, [], "precedence is silent");
  assert.equal(genericLangOf("x.sun")?.name, "sun");
  assert.equal(genericLangOf("x.sun_home"), null, "the losing home copy contributed nothing");
  assert.equal(genericLangOf("x.star")?.name, "star");

  // a second call for the same root is a no-op — no re-registration, no warnings
  const again = loadLanguagePacks(repo, { home, warn: (m) => assert.fail(m) });
  assert.deepEqual(again, { loaded: [], skipped: [] });
});

test("a pack's lsp row is picked for its language and shadows nothing built in", () => {
  const { repo, home, langs } = repoAndHome();
  // `node` is on PATH in any environment that runs this suite.
  writePack(langs, "moon", manifest("moon", ".moon", { lsp: { command: "node", args: ["-e", "0"] } }));
  loadLanguagePacks(repo, { home, warn: () => {} });
  const picked = pickServer(new Set(["moon"]));
  assert.ok(picked, "the pack's server is eligible");
  assert.equal(picked!.languageId, "moon", "languageId defaults to the pack name");
  assert.deepEqual(picked!.args, ["-e", "0"]);
  assert.ok(picked!.command.endsWith("node") && picked!.command.startsWith("/"), "resolved to an absolute path");
  assert.notEqual(pickServer(new Set(["rust"]))?.languageId, "moon", "a pack row never answers for another language");
});

// A module-per-file language: the pack says `fileModules`, its tags query captures the
// module a dotted reference names, and each distinct module a file names becomes a
// file→file import of `<Name>.<ext>` — never the file's own module, never the standard
// library, never a guess between two same-named files, and the implementation
// extension (listed first) wins over an interface twin.
const MOON_MODULE_TAGS = `
(function_declaration name: (identifier) @name) @definition.function
(function_declaration name: (dot_index_expression table: (identifier) @name)) @definition.module
(function_call name: (identifier) @name) @reference.call
(function_call name: (dot_index_expression table: (identifier) @name)) @reference.module
`;

test("fileModules: naming a module is a file→file import, resolved to the unique file of that language", async () => {
  const { repo, home, langs } = repoAndHome();
  const dir = writePack(langs, "moon", manifest("moon", ".moon", { extensions: [".moon", ".mooni"], fileModules: true, externalModules: ["string"] }));
  writeFileSync(join(dir, "tags.scm"), MOON_MODULE_TAGS);
  loadLanguagePacks(repo, { home, warn: (m) => assert.fail(m) });
  assert.equal(genericLangOf("x.moon")?.fileModules, true);
  assert.equal(genericLangOf("x.mooni")?.name, "moon");
  await warmGenericGrammars(["moon"]); // extractGeneric below runs outside a build, which would warm it

  const files: Record<string, string> = {
    "src/model.moon": "function compute() return 1 end\n",
    "src/model.mooni": "function compute() end\n", // the interface twin: same basename, second-listed extension
    "src/loader.moon": "function run() return model.compute() end\nlocal cfg = model.compute()\nlocal s = string.format(\"x\")\n",
    "src/own.moon": "function Own.helper() return 1 end\nlocal y = Own.helper()\n",
    "src/a/util.moon": "function go() return 1 end\n",
    "src/b/util.moon": "function go() return 2 end\n",
    "src/user.moon": "local u = util.go()\n",
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "moon");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports");
  const from = (src: string) => imports.filter((e) => e.source === src).map((e) => e.target).sort();

  // two references to `model` → ONE edge, to the .moon (first-listed extension), and
  // `string` (declared external) is not an import at all; an `open`-style top-level
  // reference (`cfg`, outside any function) counts, since the source is the file.
  assert.deepEqual(from("src/loader.moon"), ["src/model.moon"]);
  // the module a file defines itself is never its own import
  assert.deepEqual(from("src/own.moon"), []);
  // two `util.moon` → ambiguous → the raw name stays, no guessed edge
  assert.deepEqual(from("src/user.moon"), ["util"]);
  // every import is a file→file edge sourced at the file, not at a definition
  assert.ok(imports.every((e) => !e.source.includes("#")), "imports are sourced at the file");
});
