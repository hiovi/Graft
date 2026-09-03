/**
 * Opt-in LSP enrichment (`graft build --lsp`): add compiler-grade call edges the
 * AST resolver couldn't — chiefly member calls (`obj.foo()`) whose receiver type
 * graft can't infer, and every call in the generic breadth tier (which has no
 * receiver typing at all). For each function/method node we ask the language
 * server for its outgoing calls (call hierarchy) and map each callee's definition
 * back to a graft node, adding a `calls` edge stamped `lsp_resolved`. A server with
 * no call hierarchy (@rescript/language-server) is asked, for each call the static
 * resolver dropped as unknown or ambiguous, where the callee is defined — the exact
 * question name resolution could not answer — or, when the build passed no call
 * sites, for each function's references (the same edges seen from the callee: every
 * in-repo location that names it, inside another function, is a caller). Precision
 * is the server's (compiler-grade), so this closes the edge-recall gap WITHOUT the
 * name-guessing that halved precision (see resolve.ts). Best-effort: no server / a
 * timeout / an error → the graph is returned unchanged.
 */
import { join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relPosix } from "../../util/paths.js";
import { languageLabelOf, type RawEdge } from "../extract.js";
import { genericLangOf } from "../generic.js";
import type { GraphV1, NodeV1, EdgeV1 } from "../types.js";
import { LspClient, type LspProbe } from "./client.js";
import { pickServer, type LspServer } from "./registry.js";

const CALLABLE = new Set<NodeV1["kind"]>(["function", "method"]);
const DEFN = new Set<NodeV1["kind"]>(["function", "method", "class", "struct", "interface", "type", "enum"]);

const langOf = (path: string): string | null => genericLangOf(path)?.name ?? languageLabelOf(path);

interface Span { node: NodeV1; from: number; to: number }
const parseSpan = (s: string): [number, number] | null => {
  const m = /^L(\d+)-L(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export interface LspEnrichResult { added: number; queried: number; server: string | null; probe?: LspProbe }

export async function enrichWithLsp(
  graph: GraphV1,
  root: string,
  opts: {
    onProgress?: (done: number, total: number) => void;
    maxNodes?: number;
    /** Test seam: the server to spawn, instead of the registry's pick for the repo's languages. */
    server?: LspServer;
    /** The `calls` raw edges the resolver dropped, with their positions (resolve.ts's
     * `unresolvedCalls` sink). With a server that has no call hierarchy these are what
     * gets asked about — one definition request per dropped call. */
    callSites?: RawEdge[];
  } = {},
): Promise<LspEnrichResult> {
  const languagesPresent = new Set<string>();
  for (const n of graph.nodes) { const l = langOf(n.path); if (l) languagesPresent.add(l); }
  const server = opts.server ?? pickServer(languagesPresent);
  if (!server) return { added: 0, queried: 0, server: null };

  // Canonicalize the root: servers (rust-analyzer/clangd) report callee URIs
  // against the REAL path, so under a symlinked checkout (macOS /tmp →
  // /private/tmp, common in CI) an un-resolved root would fail the in-repo test
  // for every callee and silently zero out enrichment.
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  root = realRoot;

  // Index nodes by file for both source selection and callee→node mapping.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const spansByFile = new Map<string, Span[]>();
  for (const n of graph.nodes) {
    if (n.kind === "file" || !DEFN.has(n.kind)) continue;
    const sp = parseSpan(n.span); if (!sp) continue;
    const list = spansByFile.get(n.path) ?? [];
    list.push({ node: n, from: sp[0], to: sp[1] });
    spansByFile.set(n.path, list);
  }
  // The definition node covering a 1-indexed line in a file: innermost (smallest span).
  const nodeAt = (rel: string, line: number): NodeV1 | null => {
    const cands = (spansByFile.get(rel) ?? []).filter((s) => s.from <= line && line <= s.to);
    if (!cands.length) return null;
    return cands.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0].node;
  };

  // Source nodes to query: callable nodes in files this server handles.
  const serverLangs = new Set(server.languages);
  let sources = graph.nodes.filter((n) => CALLABLE.has(n.kind) && serverLangs.has(langOf(n.path) ?? ""));
  if (opts.maxNodes && sources.length > opts.maxNodes) sources = sources.slice(0, opts.maxNodes);

  const client = new LspClient(server.command, server.args, root, server.languageId);
  if (!(await client.initialize())) { await client.dispose(); return { added: 0, queried: 0, server: server.command }; }
  // Outgoing call hierarchy is the instrument where a server advertises it. Without
  // it: the definition of each dropped call, when the build handed us call sites and
  // the server answers definition (every server does); else, references. A server
  // advertising neither flag keeps the call-hierarchy path exactly as before (it may
  // register the capability dynamically).
  const sites = (opts.callSites ?? []).filter((e) => {
    if (!e.pos || !e.name || !serverLangs.has(langOf(e.file) ?? "")) return false;
    const src = byId.get(e.source);
    return !!src && CALLABLE.has(src.kind);
  });
  const probe: LspProbe = client.supports("callHierarchyProvider")
    ? "callHierarchy"
    : sites.length && client.supports("definitionProvider")
      ? "definition"
      : client.supports("referencesProvider")
        ? "references"
        : "callHierarchy";
  if (probe === "definition" && opts.maxNodes && sites.length > opts.maxNodes) sites.length = opts.maxNodes;

  const existing = new Set(graph.edges.map((e) => `${e.source}\0${e.relation}\0${e.target}`));
  const fileLines = new Map<string, string[]>();
  const linesOf = (rel: string): string[] => {
    if (!fileLines.has(rel)) {
      try { fileLines.set(rel, readFileSync(join(root, rel), "utf8").split("\n")); }
      catch { fileLines.set(rel, []); }
    }
    return fileLines.get(rel)!;
  };

  // The name-token position of a definition (0-indexed), scanning its first few
  // lines for the name — call hierarchy needs a position ON the symbol.
  const namePos = (src: NodeV1): { line: number; character: number } | null => {
    const sp = parseSpan(src.span); if (!sp) return null;
    const lines = linesOf(src.path);
    for (let ln = sp[0] - 1; ln < Math.min(sp[0] + 2, lines.length); ln++) {
      const c = (lines[ln] ?? "").indexOf(src.name);
      if (c >= 0) return { line: ln, character: c };
    }
    return null;
  };

  // Wait for the server to finish indexing (it answers call-hierarchy empty
  // until ready). Warm up on the first source node that has a findable position —
  // or, for the definition walk, on the first call site, without insisting: a call
  // whose callee lives outside the repo legitimately has no definition to give.
  if (probe === "definition") {
    await client.waitUntilReady(join(root, sites[0].file), sites[0].pos!, probe, 10000);
  } else {
    const warm = sources.find((s) => namePos(s));
    if (warm) {
      const wp = namePos(warm)!;
      if (!(await client.waitUntilReady(join(root, warm.path), wp, probe))) {
        await client.dispose();
        return { added: 0, queried: 0, server: server.command, probe }; // never became ready
      }
    }
  }

  let added = 0, queried = 0;
  // The graft node a server location lands in, or null when it is outside the repo
  // (a dependency) or outside every definition. In-repo iff the repo-relative path
  // doesn't escape the root (a raw `startsWith(root)` is separator-unsafe: root=/a/foo
  // matches /a/foo-bar).
  const nodeAtUri = (uri: string, line0: number): NodeV1 | null => {
    let abs: string;
    try { abs = fileURLToPath(uri); } catch { return null; }
    const rel = relPosix(root, abs);
    if (rel.startsWith("..") || rel.startsWith("/")) return null;
    return nodeAt(rel, line0 + 1);
  };
  const link = (from: NodeV1, to: NodeV1): void => {
    if (from.id === to.id) return;
    const key = `${from.id}\0calls\0${to.id}`;
    if (existing.has(key)) return;
    existing.add(key);
    graph.edges.push({ source: from.id, target: to.id, relation: "calls", confidence: "lsp_resolved" } as EdgeV1);
    added++;
  };
  if (probe === "definition") {
    for (const site of sites) {
      const abs = join(root, site.file);
      client.didOpen(abs);
      const locs = await client.definition(abs, site.pos!);
      if (!locs.length) continue;
      queried++;
      opts.onProgress?.(queried, sites.length);
      const caller = byId.get(site.source)!;
      for (const loc of locs) {
        const target = nodeAtUri(loc.uri, loc.range.start.line);
        if (target) link(caller, target);
      }
    }
    await client.dispose();
    return { added, queried, server: server.command, probe };
  }

  for (const src of sources) {
    const abs = join(root, src.path);
    client.didOpen(abs);
    const pos = namePos(src);
    if (!pos) continue;

    if (probe === "callHierarchy") {
      const items = await client.prepareCallHierarchy(abs, pos);
      if (!items.length) continue;
      queried++;
      opts.onProgress?.(queried, sources.length);
      for (const callee of await client.outgoingCalls(items[0])) {
        const target = nodeAtUri(callee.uri, callee.selectionRange?.start.line ?? callee.range.start.line);
        if (target) link(src, target);
      }
    } else {
      // Each reference is a caller when it sits inside another callable definition; a
      // reference from a type or from module level (a constant initialiser) is not a call.
      const refs = await client.references(abs, pos);
      if (!refs.length) continue;
      queried++;
      opts.onProgress?.(queried, sources.length);
      for (const ref of refs) {
        const caller = nodeAtUri(ref.uri, ref.range.start.line);
        if (caller && CALLABLE.has(caller.kind)) link(caller, src);
      }
    }
  }
  await client.dispose();
  return { added, queried, server: server.command, probe };
}
