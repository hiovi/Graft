/**
 * A stand-in language server for `lsp-enrich.test.ts`, spawned over stdio the way a
 * real one is. It speaks just enough LSP to drive both of enrich.ts's instruments, and
 * answers them from the fixture's own text instead of a compiler — a reference is a
 * whole-word occurrence of the identifier under the cursor in any `.res`/`.rs` file
 * under the workspace root, and a declaration is a line that binds it (`let name`,
 * `fn name`). Which instrument it ADVERTISES is the whole point: enrich.ts must pick
 * the definition walk (over the call sites the build hands it) or the references walk
 * when a server has no call hierarchy, and stay on call hierarchy when it does.
 * `FAKE_LSP_MODE` selects what is advertised: `references` (default — definition and
 * references, the shape of @rescript/language-server) or `callHierarchy`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";

const MODE = process.env.FAKE_LSP_MODE === "callHierarchy" ? "callHierarchy" : "references";
const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

let root = "";
interface Pos { line: number; character: number }
interface Loc { uri: string; range: { start: Pos; end: Pos } }

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    const abs = join(dir, f);
    if (statSync(abs).isDirectory()) { if (f !== "node_modules" && f !== "graft") out.push(...sourceFiles(abs)); }
    else if (/\.(res|rs)$/.test(f)) out.push(abs);
  }
  return out;
};
const wordAt = (abs: string, pos: Pos): string | null => {
  const line = readFileSync(abs, "utf8").split("\n")[pos.line] ?? "";
  for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_']*/g)) {
    if (m.index! <= pos.character && pos.character < m.index! + m[0].length) return m[0];
  }
  return null;
};
const isDeclaration = (line: string, word: string): boolean => new RegExp(`^\\s*(pub\\s+)?(let|fn|and)\\s+(rec\\s+)?${word}\\b`).test(line);
/** Whole-word occurrences of `word`. A qualified occurrence (`Model.compute`) counts
 * only when the qualifier is `module` — the file the symbol was asked about — which is
 * the one thing a real compiler would know that a text search would not. */
const occurrences = (word: string, module: string, includeDeclaration: boolean): Loc[] => {
  const out: Loc[] = [];
  for (const abs of sourceFiles(root)) {
    readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
      if (!includeDeclaration && isDeclaration(line, word)) return;
      for (const m of line.matchAll(new RegExp(`\\b${word}\\b`, "g"))) {
        const qualifier = /([A-Z][A-Za-z0-9_]*)\.$/.exec(line.slice(0, m.index!))?.[1];
        if (qualifier && qualifier !== module) continue;
        out.push({ uri: pathToFileURL(abs).toString(), range: { start: { line: i, character: m.index! }, end: { line: i, character: m.index! + word.length } } });
      }
    });
  }
  return out;
};
const moduleOf = (abs: string): string => (abs.split("/").pop() ?? "").replace(/\.(res|rs)$/, "");
/** The declaration of `word`, preferring the file a qualifier names: at `Model.compute`
 * the answer is Model.res's `compute`, however many other files declare one. */
const declarationOf = (word: string, preferModule?: string): Loc | null => {
  const files = sourceFiles(root).sort((a, b) => Number(moduleOf(b) === preferModule) - Number(moduleOf(a) === preferModule));
  for (const abs of files) {
    const lines = readFileSync(abs, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isDeclaration(lines[i], word)) {
        const c = lines[i].indexOf(word);
        return { uri: pathToFileURL(abs).toString(), range: { start: { line: i, character: c }, end: { line: i, character: c + word.length } } };
      }
    }
  }
  return null;
};
/** The body of the definition starting at `line`: down to the next blank line. */
const bodyLines = (abs: string, line: number): string[] => {
  const lines = readFileSync(abs, "utf8").split("\n");
  const out: string[] = [];
  for (let i = line; i < lines.length && (i === line || lines[i].trim() !== ""); i++) out.push(lines[i]);
  return out;
};

conn.onRequest("initialize", (p: { rootUri?: string }) => {
  root = p.rootUri ? fileURLToPath(p.rootUri) : process.cwd();
  return {
    capabilities: MODE === "callHierarchy"
      ? { textDocumentSync: 1, callHierarchyProvider: true }
      : { textDocumentSync: 1, definitionProvider: true, referencesProvider: true },
  };
});
conn.onNotification(() => {}); // initialized, didOpen, …
conn.onRequest("textDocument/references", (p: { textDocument: { uri: string }; position: Pos; context?: { includeDeclaration?: boolean } }) => {
  const abs = fileURLToPath(p.textDocument.uri);
  const word = wordAt(abs, p.position);
  return word ? occurrences(word, moduleOf(abs), !!p.context?.includeDeclaration) : [];
});
conn.onRequest("textDocument/definition", (p: { textDocument: { uri: string }; position: Pos }) => {
  const abs = fileURLToPath(p.textDocument.uri);
  const word = wordAt(abs, p.position);
  if (!word) return null;
  const line = readFileSync(abs, "utf8").split("\n")[p.position.line] ?? "";
  const qualifier = /([A-Z][A-Za-z0-9_]*)\.\s*$/.exec(line.slice(0, p.position.character))?.[1];
  const decl = declarationOf(word, qualifier);
  return decl ? [decl] : null;
});
conn.onRequest("textDocument/prepareCallHierarchy", (p: { textDocument: { uri: string }; position: Pos }) => {
  const abs = fileURLToPath(p.textDocument.uri);
  const word = wordAt(abs, p.position);
  const decl = word ? declarationOf(word) : null;
  return decl ? [{ name: word, kind: 12, uri: decl.uri, range: decl.range, selectionRange: decl.range }] : [];
});
conn.onRequest("callHierarchy/outgoingCalls", (p: { item: { name: string; uri: string; range: { start: Pos } } }) => {
  const abs = fileURLToPath(p.item.uri);
  const body = bodyLines(abs, p.item.range.start.line).join("\n");
  const seen = new Set<string>();
  const out: Array<{ to: unknown; fromRanges: unknown[] }> = [];
  for (const m of body.matchAll(/[A-Za-z_][A-Za-z0-9_']*(?=\()/g)) {
    const callee = m[0];
    if (callee === p.item.name || seen.has(callee)) continue;
    seen.add(callee);
    const decl = declarationOf(callee);
    if (decl) out.push({ to: { name: callee, kind: 12, uri: decl.uri, range: decl.range, selectionRange: decl.range }, fromRanges: [] });
  }
  return out;
});
conn.onRequest("shutdown", () => null);
conn.onNotification("exit", () => process.exit(0));
conn.listen();
