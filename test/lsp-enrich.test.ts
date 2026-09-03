/**
 * LSP enrichment tier: registry selection + graceful degradation. These run
 * without any language server installed — they assert the OPT-IN promise that
 * `graft build --lsp` is a safe no-op when no server applies (never a crash,
 * never a mutated graph), which is the contract the build relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickServer, LSP_SERVERS } from "../src/graph/lsp/registry.js";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import type { GraphV1 } from "../src/graph/types.js";

test("pickServer: no languages present → no server", () => {
  assert.equal(pickServer(new Set()), null);
});

test("pickServer: a language no registered server covers → null", () => {
  assert.equal(pickServer(new Set(["cobol", "fortran"])), null);
});

test("registry rows are well-formed (languages, command, languageId)", () => {
  for (const s of LSP_SERVERS) {
    assert.ok(s.languages.length > 0 && s.command && s.languageId, `${s.command} row shape`);
    assert.ok(Array.isArray(s.args), `${s.command} args is an array`);
  }
});

test("enrichWithLsp is a no-op when no server matches the repo's languages", async () => {
  // A graph whose only file is an unsupported language → no server is picked →
  // no process spawned, graph returned unchanged.
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["text"], scopes: [] },
    nodes: [
      { id: "notes.txt", name: "notes.txt", kind: "file", path: "notes.txt", span: "L1-L1",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [],
  };
  const before = graph.edges.length;
  const r = await enrichWithLsp(graph, "/tmp/does-not-matter");
  assert.equal(r.server, null, "no server selected for an unsupported language");
  assert.equal(r.added, 0);
  assert.equal(graph.edges.length, before, "graph edges untouched");
});

// ---------------------------------------------------------------------------
// The three instruments, driven end to end against a stand-in server spawned over
// stdio (test/lsp-fake-server-probe.ts). The fixture is chosen so the breadth tier
// CANNOT resolve the edge itself — `compute` is defined in two files, so bare-name
// resolution drops it — which is exactly the gap the LSP tier exists to close.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import type { RawEdge } from "../src/graph/extract.js";
import type { LspServer } from "../src/graph/lsp/registry.js";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "lsp-fake-server-probe.ts");
// The client spawns the server with the FIXTURE as cwd, where a bare `--import tsx`
// would not resolve — hand node the loader's absolute URL instead.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const FIXTURE: Record<string, string> = {
  "src/model.rs": "pub fn compute(x: i32) -> i32 {\n    x + 1\n}\n\npub fn unused() -> i32 {\n    2\n}\n",
  "src/other.rs": "pub fn compute(x: i32) -> i32 {\n    x * 2\n}\n",
  "src/loader.rs": "pub fn loader() -> i32 {\n    let v = model::compute(1);\n    v\n}\n\npub static CONFIG: i32 = model::compute(3);\n",
};

async function fixtureGraph(): Promise<{ dir: string; graph: GraphV1; callSites: RawEdge[] }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-lsp-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  await warmGenericGrammars(["rust"]);
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(FIXTURE)) {
    writeFileSync(join(dir, rel), src);
    const r = extractGeneric(rel, src, "rust");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const callSites: RawEdge[] = [];
  const edges = resolveEdges(nodes, raw, { unresolvedCalls: callSites });
  assert.ok(!edges.some((e) => e.relation === "calls" && e.target.endsWith("#compute")), "precondition: the ambiguous call is unresolved before enrichment");
  // Both `model::compute(…)` calls were dropped as ambiguous, and both kept their position.
  assert.deepEqual(callSites.map((c) => `${c.source}:${c.pos!.line}:${c.pos!.character}`), ["src/loader.rs#loader:1:19", "src/loader.rs#CONFIG:5:32"]);
  return { dir, graph: { meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["rust"], scopes: [] }, nodes, edges }, callSites };
}

const fakeServer = (mode: "references" | "callHierarchy"): LspServer & { env: NodeJS.ProcessEnv } => ({
  languages: ["rust"], command: process.execPath, args: ["--import", TSX, PROBE], languageId: "rust",
  env: { ...process.env, FAKE_LSP_MODE: mode },
});

test("no call hierarchy + the build's dropped call sites → the definition walk settles each one", async () => {
  const { dir, graph, callSites } = await fixtureGraph();
  const server = fakeServer("references");
  process.env.FAKE_LSP_MODE = server.env.FAKE_LSP_MODE;
  const r = await enrichWithLsp(graph, dir, { server, callSites });
  assert.equal(r.probe, "definition", "definition is preferred over references when there are call sites to ask about");
  const added = graph.edges.filter((e) => e.confidence === "lsp_resolved").map((e) => `${e.source}→${e.target}`);
  // `model::compute` inside `loader` → the server names model.rs's definition, not
  // other.rs's. The same call inside `CONFIG` is not asked: a constant is not a caller.
  assert.deepEqual(added, ["src/loader.rs#loader→src/model.rs#compute"]);
  assert.equal(r.added, 1);
  assert.equal(r.queried, 1, "one dropped call site from a callable was asked about");
});

test("no call hierarchy and no call sites → the references walk: callers become lsp_resolved edges", async () => {
  const { dir, graph } = await fixtureGraph();
  const server = fakeServer("references");
  process.env.FAKE_LSP_MODE = server.env.FAKE_LSP_MODE;
  const r = await enrichWithLsp(graph, dir, { server });
  assert.equal(r.probe, "references", "chose the references walk");
  assert.equal(r.server, process.execPath);
  const added = graph.edges.filter((e) => e.confidence === "lsp_resolved").map((e) => `${e.source}→${e.target}`);
  // loader's reference is inside a function → a caller. `CONFIG`'s reference is a
  // module-level static → not a call. other.rs's `compute` is a declaration, and the
  // queried definition itself is excluded — neither is a caller.
  assert.deepEqual(added, ["src/loader.rs#loader→src/model.rs#compute"]);
  assert.equal(r.added, 1);
  assert.ok(r.queried >= 1, "at least the referenced function was queried");
});

test("a server that advertises call hierarchy keeps the call-hierarchy walk, call sites or not", async () => {
  const { dir, graph, callSites } = await fixtureGraph();
  const server = fakeServer("callHierarchy");
  process.env.FAKE_LSP_MODE = server.env.FAKE_LSP_MODE;
  const r = await enrichWithLsp(graph, dir, { server, callSites });
  assert.equal(r.probe, "callHierarchy");
  const added = graph.edges.filter((e) => e.confidence === "lsp_resolved").map((e) => `${e.source}→${e.target}`);
  // Outgoing from `loader`: its body calls `compute`, whose (first) declaration the
  // stand-in finds in model.rs — the same edge, discovered from the caller's side.
  assert.deepEqual(added, ["src/loader.rs#loader→src/model.rs#compute"]);
});
