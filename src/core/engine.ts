// Parse + print. Runs inside the worker; the CST stays here so option changes can re-print
// without re-parsing.

import { parse, type Program } from "sql-parser-cst";
import type { Dialect, DialectChoice, ParseError, PrintOptions, PrintResult } from "./model";
import { print } from "./print";

export type ParseOutcome = { ok: true; cst: Program; dialect: Dialect } | { ok: false; error: ParseError };

const paramTypes: Record<Dialect, ("?" | ":name" | "$nr")[]> = {
  postgresql: [":name", "$nr"],
  mysql: ["?", ":name"],
};

/** Parse in one dialect, or with `auto`: Postgres, then MySQL if that fails (`` ` `` quotes, `#` comments, ...). */
export function parseSql(sql: string, dialect: DialectChoice = "auto"): ParseOutcome {
  if (dialect !== "auto") return parseIn(sql, dialect);
  const pg = parseIn(sql, "postgresql");
  if (pg.ok) return pg;
  const my = parseIn(sql, "mysql");
  if (my.ok) return my;
  // Neither parsed: report the error from whichever got further, likely the intended dialect.
  const a = pg.error;
  const b = my.error;
  return b.line > a.line || (b.line === a.line && b.col > a.col) ? my : pg;
}

function parseIn(sql: string, dialect: Dialect): ParseOutcome {
  try {
    const cst = parse(sql, {
      dialect,
      paramTypes: paramTypes[dialect],
      includeRange: true,
      includeComments: true,
      filename: "input",
    });
    return { ok: true, cst, dialect };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /--> input:(\d+):(\d+)/.exec(message);
    return {
      ok: false,
      error: {
        dialect,
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
