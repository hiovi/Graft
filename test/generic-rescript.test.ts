/**
 * ReScript on the breadth tier: a vendored WASM grammar (tree-sitter-wasm ships none)
 * plus graft's own tags query. Three things are ReScript-specific enough to pin here
 * rather than in the one-row-per-language table in generic-extract.test.ts:
 *
 *   - only MODULE-LEVEL lets are definitions (a function body is nothing but lets), and
 *     a binding's kind follows its shape: function-valued → function, signature with an
 *     arrow → function, anything else → constant;
 *   - a file IS a module, so naming one (`Foo.bar`, `open Foo`, `<Foo />`, `Foo.t`) is a
 *     file→file import the resolver settles to the unique `Foo.res` — never a module the
 *     file defines itself, never a guess between two same-named files, never the stdlib;
 *   - `x->f` pipes are calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmGenericGrammars, extractGeneric, genericLangOf, isWarm } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { skeleton } from "../src/ask/ask.js";

const COUNTER = `open Belt

type t = {count: int}
type rec tree = Leaf | Node(tree, tree)
and forest = list<tree>
exception Overflow(int)

external now: unit => float = "Date.now"
@val external window: Dom.window = "window"

let limit = 10
let make = (): t => {count: 0}
let rec bump = (t: t): t =>
  if t.count >= limit {
    raise(Overflow(t.count))
  } else {
    let next = t.count + 1
    let log = () => Console.log(next)
    log()
    {count: next}
  }
and twice = (t: t) => t->bump->bump
let describe = (t: t) => t->Format.pretty(~width=80)

module Inner = {
  let deep = (t: t) => bump(t)
  module type Sig = {
    let go: unit => unit
    let name: string
  }
}
module Make = (M: Inner.Sig) => {
  let run = () => M.go()
}

@react.component
let component = (~title) => {
  let (open_, setOpen) = React.useState(() => false)
  <div onClick={_ => setOpen(o => !o)}> <Inner.Panel title /> <Widget /> </div>
}
`;

test("genericLangOf routes .res and .resi to the breadth tier", () => {
  assert.equal(genericLangOf("src/Counter.res")?.name, "rescript");
  assert.equal(genericLangOf("src/Counter.resi")?.name, "rescript");
  assert.equal(genericLangOf("src/Counter.res.mjs"), null, "compiled output is JavaScript, not ReScript");
});

test("the vendored ReScript grammar warms and its tags query compiles (defs are tagged, not walked)", async () => {
  await warmGenericGrammars(["rescript"]);
  assert.ok(isWarm("rescript"), "rescript grammar warms from src/graph/grammars");
  const { nodes } = extractGeneric("Counter.res", COUNTER, "rescript");
  // The node-kind walker fallback would mint `let_declaration`-shaped locals like
  // `next` and `log`; only the query knows a function body's lets are not the API.
  assert.ok(!nodes.some((n) => n.name === "next" || n.name === "log"), "function-body lets are not definitions");
});

test("ReScript definitions: module-level lets by shape, types, modules, externals, exceptions", async () => {
  await warmGenericGrammars(["rescript"]);
  const { nodes } = extractGeneric("Counter.res", COUNTER, "rescript");
  const kinds = nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(kinds, [
    "constant:limit", // a plain value
    "constant:name", // signature without an arrow
    "constant:window", // value external
    "function:bump", "function:component", "function:deep", "function:describe", "function:make", "function:run", "function:twice",
    "function:go", // signature with an arrow
    "function:now", // function-typed external
    "interface:Sig", // module type
    "module:Inner", "module:Make",
    "type:Overflow", "type:forest", "type:t", "type:tree",
  ].sort());
  const byName = new Map(nodes.map((n) => [n.name, n]));
  // A definition's span covers its body — that is what attributes the calls inside it.
  assert.equal(byName.get("bump")?.span, "L13-L21");
  // `let rec … and …` is one let_declaration; each binding is still its own definition.
  assert.equal(byName.get("twice")?.span, "L22-L22");
  // The decorator stays out of the span; the signature line is the `let`.
  assert.equal(byName.get("component")?.span, "L37-L40");
  assert.equal(byName.get("component")?.signature, "let component = (~title) =>");
  assert.ok(nodes.filter((n) => n.kind !== "file").every((n) => n.origin === "generic"));
});

test("ReScript calls: bare, module-qualified and piped calls resolve; body locals attribute to their function", async () => {
  await warmGenericGrammars(["rescript"]);
  const { nodes, rawEdges } = extractGeneric("Counter.res", COUNTER, "rescript");
  const raw = rawEdges.filter((e) => e.relation === "calls").map((e) => `${e.source.split("#")[1] ?? "<file>"}→${e.name}`);
  assert.ok(raw.includes("bump→raise"), "bare call inside a function body");
  assert.ok(raw.includes("twice→bump"), "`t->bump` pipe is a call");
  assert.ok(raw.includes("describe→pretty"), "`t->Format.pretty(…)` keeps the function name");
  assert.ok(raw.includes("deep→bump"), "call inside a nested module attributes to its function");
  assert.ok(raw.includes("run→go"), "`M.go()` inside a functor");
  assert.ok(raw.includes("bump→log"), "a call to a body-local attributes to the enclosing definition, not the local");
  assert.ok(!raw.some((r) => r.startsWith("<file>→")), `every call sits inside a definition (got ${raw.filter((r) => r.startsWith("<file>")).join(", ")})`);

  const edges = resolveEdges(nodes, rawEdges);
  const calls = edges.filter((e) => e.relation === "calls").map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1]}`);
  assert.ok(calls.includes("twice→bump"), `piped call resolved same-file (got ${calls.join(", ")})`);
  assert.ok(calls.includes("deep→bump"), "nested-module call resolved same-file");
  assert.ok(!calls.some((c) => c.endsWith("→raise") || c.endsWith("→log")), "unresolvable callees are dropped, not guessed");
});

test("ReScript imports: naming a module is a file→file dependency; own modules, ambiguity and the stdlib are not", async () => {
  await warmGenericGrammars(["rescript"]);
  const files: Record<string, string> = {
    "app/Counter.res": COUNTER,
    "app/Format.res": "let pretty = (t, ~width) => width\n",
    "app/Widget.res": "@react.component\nlet make = () => <div />\n",
    // Two `Panel.res` → `<Inner.Panel />` names Counter's OWN module anyway; `Overflow`
    // is defined in Counter too, and must not become an import of this file.
    "app/Panel.res": "let a = 1\n",
    "lib/Panel.res": "let b = 2\n",
    "app/Overflow.res": "let c = 3\n",
    "lib/Store.res": "open Counter\nlet fresh = () => Counter.make()->Counter.bump\nlet w = Widget.make()\n",
    "lib/Kind.res": "type t = Counter.t\nlet k = Widget.Kind.Deep\n",
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "rescript");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports");
  const from = (src: string) => imports.filter((e) => e.source === src).map((e) => e.target).sort();

  // Counter.res: `open Belt`, `Console.log` and `Dom.window` are stdlib (dropped),
  // `Format.pretty` and `<Widget />` are in-repo files, `React` stays an external string,
  // and `Inner` (its own module), `M` (a functor parameter), `Overflow` (its own
  // exception) and `Counter` (itself) are not imports at all.
  assert.deepEqual(from("app/Counter.res"), ["React", "app/Format.res", "app/Widget.res"]);
  // Store.res: `open Counter` + `Counter.make()`/`Counter.bump` → ONE edge; `Widget.make()` too.
  assert.deepEqual(from("lib/Store.res"), ["app/Counter.res", "app/Widget.res"]);
  // Kind.res: a type path and a variant path name their module just as a call does.
  assert.deepEqual(from("lib/Kind.res"), ["app/Counter.res", "app/Widget.res"]);
  // Nothing imports a `Panel` — the only naming of one is Counter's own nested module.
  assert.ok(!imports.some((e) => /Panel/.test(String(e.target))), "an own nested module never resolves to a same-named file");
});

test("ReScript imports: a .resi is the same module as its .res, and the .res wins", async () => {
  await warmGenericGrammars(["rescript"]);
  const files: Record<string, string> = {
    "src/Api.res": "let get = () => 1\n",
    "src/Api.resi": "let get: unit => int\n",
    "src/Only.resi": "let x: int\n",
    "src/App.res": "let a = Api.get()\nlet b = Only.x\n",
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "rescript");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const targets = resolveEdges(nodes, raw).filter((e) => e.relation === "imports" && e.source === "src/App.res").map((e) => e.target).sort();
  assert.deepEqual(targets, ["src/Api.res", "src/Only.resi"]);
  // and the interface file's own signatures are definitions
  const resi = nodes.filter((n) => n.path === "src/Api.resi" && n.kind !== "file").map((n) => `${n.kind}:${n.name}`);
  assert.deepEqual(resi, ["function:get"]);
});

test("buildGraph + skeleton on a ReScript repo end-to-end: cross-file edges and a real API listing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rescript-"));
  mkdirSync(join(dir, "src", "models"), { recursive: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "src", "models", "Memory.res"),
    "type t = {id: int, summary: string}\nlet decode = (json: JSON.t): t => {id: 1, summary: \"x\"}\nlet toJson = (m: t) => JSON.Encode.int(m.id)\n");
  writeFileSync(join(dir, "src", "routes", "MemoriesRoute__Loader.res"),
    "let loader = async () => {\n  let rows = [Memory.decode(JSON.Encode.null)]\n  rows->Array.map(Memory.toJson)\n}\n");

  await buildGraph(dir, { reuse: false });
  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  const defs = g!.nodes.filter((n) => n.path.endsWith(".res") && n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(defs, ["function:decode", "function:loader", "function:toJson", "type:t"]);
  const calls = g!.edges.filter((e) => e.relation === "calls").map((e) => `${e.source}→${e.target}`);
  assert.ok(calls.includes("src/routes/MemoriesRoute__Loader.res#loader→src/models/Memory.res#decode"), `loader → Memory.decode (got ${calls.join(", ")})`);
  const imports = g!.edges.filter((e) => e.relation === "imports").map((e) => `${e.source}→${e.target}`);
  assert.ok(imports.includes("src/routes/MemoriesRoute__Loader.res→src/models/Memory.res"), `route imports the model file (got ${imports.join(", ")})`);
  assert.ok(!imports.some((i) => /→(JSON|Array)$/.test(i)), "stdlib modules are not imports");

  const names = skeleton(dir, "src/models/Memory.res").entries.map((e) => e.name);
  assert.deepEqual(names.sort(), ["decode", "t", "toJson"], "skeleton lists the model's API");
});
