// Dev helper: format a .sql file in Node and print the result (all folds open, or closed with --folded).
import fs from "node:fs";
import { parseSql, printSql } from "../src/core/engine";
import { layout, toText } from "../src/core/layout";
import { defaultPrintOptions, type DialectChoice } from "../src/core/model";

const file = process.argv[2];
const depthArg = process.argv.find((a) => a.startsWith("--depth="));
const folded = process.argv.includes("--folded") || !!depthArg;
const maxDepth = depthArg ? Number(depthArg.slice(8)) : 0;
const width = Number(process.argv.find((a) => a.startsWith("--width="))?.slice(8) ?? 100);
const dialect = (process.argv.find((a) => a.startsWith("--dialect="))?.slice(10) ?? "auto") as DialectChoice;
const sql = fs.readFileSync(file, "utf8");
const t0 = performance.now();
const p = parseSql(sql, dialect);
if (!p.ok) {
  console.error("PARSE ERROR", p.error);
  process.exit(1);
}
const t1 = performance.now();
const r = printSql(p.cst, sql, defaultPrintOptions, p.dialect);
const t2 = performance.now();
const out = layout(r.doc, {
  width,
  isOpen: (id) => {
    if (!folded) return true;
    let d = 0;
    for (let p = r.folds[id].parent; p; p = r.folds[p].parent) d++;
    return r.folds[id].defaultOpen || (d < maxDepth && r.folds[id].kind !== "columns");
  },
  label: (id) => `▸ ${r.folds[id].name}${r.folds[id].count ? ` (${r.folds[id].count})` : ""}`,
});
const t3 = performance.now();
const text = toText(out);
if (!process.argv.includes("--quiet")) console.log(text);
console.error(
  `${p.dialect}: parse ${(t1 - t0).toFixed(0)}ms print ${(t2 - t1).toFixed(0)}ms layout ${(t3 - t2).toFixed(0)}ms; ` +
    `${out.lines.length} lines, ${Object.keys(r.folds).length} folds`,
);
// Sanity: formatted output must re-parse when fully expanded.
if (!folded) {
  const again = parseSql(text, p.dialect);
  console.error(again.ok ? "re-parse OK" : `RE-PARSE FAILED: ${again.error.message} at ${again.error.line}:${again.error.col}`);
}
