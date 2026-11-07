// Display labels for sections, shared by the sidebar and the query path.
import { result, sectionChildren } from "../state/store";

/** `"ROWS"` -> `ROWS`: quotes are noise in navigation. */
export function unquote(s: string): string {
  return s.replace(/"((?:[^"]|"")*)"/g, (_, x: string) => x.replace(/""/g, '"'));
}

/** Breadcrumb label: a UNION arm's name for an arm's query, the owner's name for a UNION. */
export function queryLabel(id: number): string {
  const secs = result.value?.sections ?? [];
  const s = secs[id];
  if (s.kind === "union") {
    const first = sectionChildren(id).map((a) => secs[a]).find((a) => a.kind === "arm");
    return first ? first.label.replace(/#\d+$/, "") : s.label;
  }
  const p = s.parent !== null ? secs[s.parent] : null;
  return p?.kind === "arm" ? p.label : s.label;
}
