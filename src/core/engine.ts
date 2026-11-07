// Parse + print. Runs inside the worker; the CST stays here so option changes can re-print
// without re-parsing.

import { parse, type Program } from "sql-parser-cst";
import type { ParseError, PrintOptions, PrintResult } from "./model";
import { print } from "./print";

export type ParseOutcome = { ok: true; cst: Program } | { ok: false; error: ParseError };

export function parseSql(sql: string): ParseOutcome {
  try {
    const cst = parse(sql, {
      dialect: "postgresql",
      paramTypes: [":name", "$nr"],
      includeRange: true,
      includeComments: true,
      filename: "input",
    });
    return { ok: true, cst };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /--> input:(\d+):(\d+)/.exec(message);
    return {
      ok: false,
      error: {
        message: message.split("\n--> ")[0],
        line: m ? Number(m[1]) : 1,
        col: m ? Number(m[2]) : 1,
      },
    };
  }
}

export function printSql(cst: Program, sql: string, opts: PrintOptions): PrintResult {
  return print(cst, sql, opts);
}
