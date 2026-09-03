/**
 * Bundles the viewer into dist/viewer/ (app.js via esbuild + copied static
 * assets). Runs as part of `npm run build`; the bundle ships in the package
 * so `graft viz` needs no install or build step at runtime.
 */
import { build } from "esbuild";
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist", "viewer");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "viewer", "main.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: join(outDir, "app.js"),
});

for (const asset of ["index.html", "style.css"]) {
  copyFileSync(join(root, "viewer", asset), join(outDir, asset));
}

console.log("viewer bundle → dist/viewer/");

// The generic (breadth) tier's tags.scm query files are runtime assets — tsc
// doesn't emit non-TS files, so copy them into dist so the published package
// (which ships `dist` only) can load them. generic.ts resolves dist/graph/queries
// first, then falls back to src/graph/queries for local dev.
const scmSrc = join(root, "src", "graph", "queries");
const scmOut = join(root, "dist", "graph", "queries");
mkdirSync(scmOut, { recursive: true });
let scmCount = 0;
for (const f of readdirSync(scmSrc)) {
  if (f.endsWith(".scm")) {
    copyFileSync(join(scmSrc, f), join(scmOut, f));
    scmCount++;
  }
}
console.log(`grammar queries → dist/graph/queries/ (${scmCount} .scm)`);

// Grammars the tree-sitter-wasm bundle doesn't ship are vendored the same way
// (src/graph/grammars/<lang>/tree-sitter-<lang>.wasm); generic.ts looks in
// dist/graph/grammars first, then src/graph/grammars.
const wasmSrc = join(root, "src", "graph", "grammars");
const wasmOut = join(root, "dist", "graph", "grammars");
let wasmCount = 0;
for (const lang of readdirSync(wasmSrc, { withFileTypes: true })) {
  if (!lang.isDirectory()) continue;
  mkdirSync(join(wasmOut, lang.name), { recursive: true });
  for (const f of readdirSync(join(wasmSrc, lang.name))) {
    if (f.endsWith(".wasm")) {
      copyFileSync(join(wasmSrc, lang.name, f), join(wasmOut, lang.name, f));
      wasmCount++;
    }
  }
}
console.log(`vendored grammars → dist/graph/grammars/ (${wasmCount} .wasm)`);
