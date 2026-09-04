/**
 * Language packs — a language graft never heard of, one directory away.
 *
 * Every built-in breadth-tier language is a row in generic.ts plus a grammar the
 * `tree-sitter-wasm` bundle happens to ship. A language the bundle lacks would need a
 * vendored binary in graft's own tree, and a language only one team uses would need a
 * row nobody else wants. A pack moves both out of graft: a directory holding the
 * grammar wasm, the tags query and a manifest, discovered at build time from
 *
 *   <repo>/.graft/langs/<name>/pack.json    (travels with the repo)
 *   ~/.graft/langs/<name>/pack.json         (this machine, every repo)
 *
 * with the repo-level pack winning a name clash. A pack contributes exactly what a
 * built-in row does — extensions, grammar, tags query, optionally one LSP server row —
 * and is refused, with one stderr line, when it would take a language away from a repo:
 * a name or an extension another tier already owns, a grammar or query file that is
 * not there. Refusal never fails the build; the repo indexes as it did before. A
 * home-level pack whose name a repo-level pack already took is not a refusal — that
 * is the documented precedence — so it is passed over in silence.
 *
 * The manifest:
 *
 *   {
 *     "name": "moon",
 *     "extensions": [".moon"],
 *     "grammar": "tree-sitter-moon.wasm",
 *     "tags": "tags.scm",
 *     "lsp": { "command": "moon-lsp", "args": ["--stdio"], "languageId": "moon" }
 *   }
 *
 * Paths are relative to the pack directory. `tags` is optional — without it the
 * grammar goes through generic.ts's node-kind walker (symbols, no calls), as OCaml and
 * Zig do today. `lsp.args` defaults to none, `lsp.languageId` to the pack's name.
 * `"fileModules": true` says a file is a module named by its basename, so each module
 * the tags query captures as `@reference.module` is a file→file import (see
 * `LanguagePack`); `"externalModules"` lists the names that never are one, and
 * `"namespaces"` names the package manifest whose `namespace` prefixes a package's
 * modules (`loadNamespaces`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { relPosix } from "../util/paths.js";
import { languageOf } from "./extract.js";
import { containerLangOf } from "./container.js";
import { GENERIC_LANGS, allGenericLangs, genericLangOf, registerGenericLang } from "./generic.js";
import { registerLspServer } from "./lsp/registry.js";

export interface LanguagePack {
  name: string;
  extensions: string[];
  grammar: string;
  tags?: string;
  lsp?: { command: string; args?: string[]; languageId?: string };
  /** A file is a module named by its basename, and a `@reference.module` capture in the
   * tags query is a file→file import of it. List the implementation extension first in
   * `extensions`: it wins when an interface file shares the basename. */
  fileModules?: boolean;
  /** With `fileModules`: names never resolved (the standard library) — skipped, not
   * left as unresolved import strings. */
  externalModules?: string[];
  /** With `fileModules`: the basename(s) of a package manifest whose `namespace` field
   * (`true` → derived from `name`, or a string) prefixes every module in that package —
   * ReScript's `rescript.json`. `Matrix.Encode` then means the `Encode.res` under the
   * package declaring namespace `Matrix`, and a file inside that package sees its
   * siblings unqualified. Without this, two packages' `Encode.res` are one ambiguity. */
  namespaces?: string | string[];
}

export interface PackLoadResult {
  /** Pack names registered by this call (already-registered packs are not repeated). */
  loaded: string[];
  /** Directories that held a pack.json graft could not accept, with the reason. */
  skipped: Array<{ dir: string; reason: string }>;
}

/** The directories searched for `<name>/pack.json`, in priority order. */
export function packDirs(root: string, home: string = homedir()): string[] {
  return [join(resolve(root), ".graft", "langs"), join(home, ".graft", "langs")];
}

const NAME = /^[a-z][a-z0-9_]*$/;
const registered = new Set<string>(); // pack names
const registeredDirs = new Set<string>(); // pack directories, so a re-scan is silent
const seenRoots = new Set<string>();

/**
 * Discover and register the packs that apply to `root`. Idempotent per root: the walk
 * (`listSourceFiles`), the `-e` validation and a test may each call it, and the first
 * call does the work. Returns what it loaded and what it refused; a refused pack is
 * also reported on stderr (`warn`), because silence here is how a language quietly
 * goes missing from a graph.
 */
export function loadLanguagePacks(
  root: string,
  opts: { home?: string; warn?: (message: string) => void } = {},
): PackLoadResult {
  const home = opts.home ?? homedir();
  const key = `${resolve(root)}\0${home}`;
  const result: PackLoadResult = { loaded: [], skipped: [] };
  if (seenRoots.has(key)) return result;
  seenRoots.add(key);
  const warn = opts.warn ?? ((m: string) => console.error(m));

  for (const base of packDirs(root, home)) {
    let entries: string[];
    try {
      entries = readdirSync(base).sort();
    } catch {
      continue; // no such directory — the common case
    }
    for (const entry of entries) {
      const dir = join(base, entry);
      try {
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, "pack.json"))) continue;
      } catch {
        continue;
      }
      if (registeredDirs.has(dir)) continue; // loaded for another (root, home) pair already
      // The repo-level directory is scanned first; a home-level pack of a name it took
      // is the precedence rule working, not a broken pack — no warning.
      if (base !== packDirs(root, home)[0] && registered.has(readName(dir))) continue;
      const outcome = loadPack(dir);
      if (outcome.ok) {
        registeredDirs.add(dir);
        result.loaded.push(outcome.name);
      } else {
        result.skipped.push({ dir, reason: outcome.reason });
        warn(`graft: language pack skipped (${dir}): ${outcome.reason}`);
      }
    }
  }
  return result;
}

/** The manifest's `name`, or "" when it cannot be read — precedence only needs the name. */
function readName(dir: string): string {
  try {
    const name = (JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

type Outcome = { ok: true; name: string } | { ok: false; reason: string };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

/** Register one pack, or say why it cannot be. */
function loadPack(dir: string): Outcome {
  let pack: LanguagePack;
  try {
    pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as LanguagePack;
  } catch (err) {
    return refuse(`pack.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof pack.name !== "string" || !NAME.test(pack.name)) return refuse(`"name" must match ${NAME} (got ${JSON.stringify(pack.name)})`);
  if (registered.has(pack.name)) return refuse(`a pack named "${pack.name}" is already loaded (a repo-level pack wins over ~/.graft/langs)`);
  if (GENERIC_LANGS.some((l) => l.name === pack.name)) return refuse(`"${pack.name}" is a built-in language`);
  if (!Array.isArray(pack.extensions) || pack.extensions.length === 0 || !pack.extensions.every((e) => typeof e === "string" && /^\.[A-Za-z0-9_+-]+$/.test(e)))
    return refuse(`"extensions" must be a non-empty list like [".moon"]`);
  const exts = pack.extensions.map((e) => e.toLowerCase());
  for (const e of exts) {
    // A probe file name is enough: every tier decides by extension alone.
    const owner = languageOf(`x${e}`) ?? containerLangOf(`x${e}`)?.name ?? genericLangOf(`x${e}`)?.name;
    if (owner) return refuse(`extension ${e} is already indexed as ${owner}`);
  }
  if (typeof pack.grammar !== "string") return refuse(`"grammar" must name the wasm file`);
  const wasmPath = join(dir, pack.grammar);
  if (!existsSync(wasmPath)) return refuse(`grammar not found: ${pack.grammar}`);
  let queryPath: string | undefined;
  if (pack.tags !== undefined) {
    if (typeof pack.tags !== "string") return refuse(`"tags" must name the tags query file`);
    queryPath = join(dir, pack.tags);
    if (!existsSync(queryPath)) return refuse(`tags query not found: ${pack.tags}`);
  }
  if (pack.lsp !== undefined && (typeof pack.lsp !== "object" || typeof pack.lsp.command !== "string"))
    return refuse(`"lsp" must be { "command": "…", "args": […], "languageId": "…" }`);
  if (pack.fileModules !== undefined && typeof pack.fileModules !== "boolean") return refuse(`"fileModules" must be true or false`);
  if (pack.externalModules !== undefined && (!Array.isArray(pack.externalModules) || !pack.externalModules.every((m) => typeof m === "string")))
    return refuse(`"externalModules" must be a list of module names`);
  const namespaceManifests = pack.namespaces === undefined ? [] : typeof pack.namespaces === "string" ? [pack.namespaces] : pack.namespaces;
  if (!Array.isArray(namespaceManifests) || !namespaceManifests.every((m) => typeof m === "string" && m.length > 0))
    return refuse(`"namespaces" must be a manifest basename (or a list of them), e.g. "rescript.json"`);

  registerGenericLang({
    name: pack.name, exts, wasm: pack.name, wasmPath, queryPath,
    fileModules: pack.fileModules === true,
    externalModules: pack.externalModules ?? [],
    namespaceManifests,
    namespaceDirs: new Map(),
  });
  if (pack.lsp) {
    registerLspServer({
      languages: [pack.name],
      command: pack.lsp.command,
      args: Array.isArray(pack.lsp.args) ? pack.lsp.args : [],
      languageId: pack.lsp.languageId ?? pack.name,
    });
  }
  registered.add(pack.name);
  return { ok: true, name: pack.name };
}

/**
 * ReScript's rule for turning a package name or `namespace` string into the module
 * prefix the compiler uses (`Ext_namespace.namespace_of_package_name`): letters and
 * digits survive, the first and every one after a `/` or `-` capitalized, everything
 * else dropped. `rescript-json` → `RescriptJson`, `json` → `Json`, `@org/x-y` → `OrgXY`.
 */
export function namespaceOfPackageName(name: string): string {
  let out = "";
  let capital = true;
  for (const ch of name) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += capital ? ch.toUpperCase() : ch;
      capital = false;
    } else if (ch === "/" || ch === "-") {
      capital = true;
    }
  }
  return out;
}

const namespacedRoots = new Set<string>();

/**
 * Fill every namespace-declaring pack's `namespaceDirs` from the manifests found in
 * `repoFiles` (the build's own walk, so no second traversal): each manifest's
 * `namespace` (`true` → its `name`) maps to the directory holding it. Idempotent per
 * root, and a no-op for packs without `namespaces`.
 */
export function loadNamespaces(root: string, repoFiles: readonly string[]): void {
  const key = resolve(root);
  if (namespacedRoots.has(key)) return;
  namespacedRoots.add(key);
  const rows = allGenericLangs().filter((l) => l.namespaceManifests?.length && l.namespaceDirs);
  if (rows.length === 0) return;
  for (const abs of repoFiles) {
    const base = basename(abs);
    for (const row of rows) {
      if (!row.namespaceManifests!.includes(base)) continue;
      let manifest: { name?: unknown; namespace?: unknown };
      try {
        manifest = JSON.parse(readFileSync(abs, "utf8")) as typeof manifest;
      } catch {
        continue; // an unreadable manifest declares nothing
      }
      const declared = manifest.namespace === true ? manifest.name : manifest.namespace;
      if (typeof declared !== "string" || !declared) continue;
      const ns = namespaceOfPackageName(declared);
      if (!ns) continue;
      const dir = relPosix(key, abs).split("/").slice(0, -1).join("/");
      row.namespaceDirs!.set(ns, dir);
    }
  }
}

/** Test seam: forget every loaded pack and root, so tests can load fixtures afresh. */
export function resetLanguagePacksForTest(): void {
  registered.clear();
  registeredDirs.clear();
  seenRoots.clear();
  namespacedRoots.clear();
}
