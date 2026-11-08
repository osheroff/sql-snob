import type { Program } from "sql-parser-cst";
import { parseSql, printSql } from "../core/engine";
import type { Dialect } from "../core/model";
import type { Request, Response } from "./protocol";

let cst: Program | null = null;
let sql = "";
let dialect: Dialect = "postgresql";

self.onmessage = (ev: MessageEvent<Request>) => {
  const req = ev.data;
  let res: Response;
  let parseMs = 0;
  if (req.type === "load") {
    const t0 = performance.now();
    const out = parseSql(req.sql, req.dialect);
    parseMs = performance.now() - t0;
    if (!out.ok) {
      cst = null;
      res = { id: req.id, ok: false, error: out.error };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    cst = out.cst;
    sql = req.sql;
    dialect = out.dialect;
  }
  if (!cst) {
    res = { id: req.id, ok: false, error: { message: "Nothing loaded", line: 1, col: 1 } };
  } else {
    const t1 = performance.now();
    const result = printSql(cst, sql, req.opts, dialect);
    res = { id: req.id, ok: true, result, dialect, ms: { parse: parseMs, print: performance.now() - t1 } };
  }
  (self as unknown as Worker).postMessage(res);
};
