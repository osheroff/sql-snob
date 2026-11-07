import type { ParseError, PrintOptions, PrintResult } from "../core/model";

export type Request =
  | { id: number; type: "load"; sql: string; opts: PrintOptions }
  | { id: number; type: "reprint"; opts: PrintOptions };

export type Response =
  | { id: number; ok: true; result: PrintResult; ms: { parse: number; print: number } }
  | { id: number; ok: false; error: ParseError };
