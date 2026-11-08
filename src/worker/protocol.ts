import type { Dialect, DialectChoice, ParseError, PrintOptions, PrintResult } from "../core/model";

export type Request =
  | { id: number; type: "load"; sql: string; dialect: DialectChoice; opts: PrintOptions }
  | { id: number; type: "reprint"; opts: PrintOptions };

export type Response =
  | { id: number; ok: true; result: PrintResult; dialect: Dialect; ms: { parse: number; print: number } }
  | { id: number; ok: false; error: ParseError };
