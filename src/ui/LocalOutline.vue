<script setup lang="ts">
// Local outline: a navigation table of the query around the cursor. It mirrors the query's
// structure (columns, tables, conditions, ...) without trying to repeat all of its text.
import { computed, nextTick, ref, watch } from "vue";
import type { Section, SectionKind } from "../core/model";
import { caretToFold, caretToSection, firstQuery, localOutline, result, sectionChildren, state } from "../state/store";

const el = ref<HTMLElement>();
const secs = computed(() => result.value?.sections ?? []);
const lo = computed(() => localOutline.value);

/** `"ROWS"` -> `ROWS`: quotes are noise in a navigation list. */
function unquote(s: string): string {
  return s.replace(/"((?:[^"]|"")*)"/g, (_, x: string) => x.replace(/""/g, '"'));
}

/** Shorten a long name in the middle: generated names differ at the end (`…_3bd304_0`). */
function mid(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) / 2);
  return s.slice(0, max - 1 - tail) + "…" + s.slice(-tail);
}

const HEADING: Partial<Record<SectionKind, string>> = {
  with: "WITH",
  select: "SELECT",
  from: "TABLES",
  where: "WHERE",
  having: "HAVING",
  qualify: "QUALIFY",
  groupby: "GROUP BY",
  orderby: "ORDER BY",
};

/** Short join-type badge. */
function joinBadge(s: Section): string {
  if (s.kind === "source") return "from";
  const op = (s.op ?? "").toUpperCase();
  if (op === ",") return "cross";
  for (const k of ["LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "INNER"]) if (op.includes(k)) return k.toLowerCase();
  return "inner";
}

/** Rows that lead into a subquery: a derived table, or a CTE. */
function isSubquery(s: Section): boolean {
  return !!s.targetFold || s.kind === "cte";
}

/** Breadcrumb label of a query: an arm's name if it's a UNION arm. */
function queryLabel(id: number): string {
  const s = secs.value[id];
  const p = s.parent !== null ? secs.value[s.parent] : null;
  return p?.kind === "arm" ? p.label : s.label;
}

/** If the query is a UNION arm: its position, and its sibling arms. */
const arm = computed(() => {
  const l = lo.value;
  if (!l) return null;
  const q = secs.value[l.query];
  const a = q.parent !== null ? secs.value[q.parent] : null;
  if (a?.kind !== "arm" || a.parent === null) return null;
  const arms = sectionChildren(a.parent);
  return { op: secs.value[a.parent].label, index: arms.indexOf(a.id), arms };
});
function gotoArm(i: number) {
  const a = arm.value;
  if (!a || a.arms[i] === undefined) return;
  // Land inside the arm's query (the arm itself starts at its parenthesis, part of the outer query).
  const stack = [a.arms[i]];
  while (stack.length) {
    const s = stack.shift()!;
    if (secs.value[s].kind === "query") return caretToSection(s);
    stack.push(...sectionChildren(s));
  }
}

const clauses = computed(() => {
  const l = lo.value;
  if (!l) return [];
  return sectionChildren(l.query).map((cid) => ({ c: secs.value[cid], items: sectionChildren(cid).map((i) => secs.value[i]) }));
});

/** Long item lists outside the current clause are cut short, unless expanded. */
const LONG = 12;
const SHORT = 6;
const expanded = ref(new Set<number>());
function shown(clauseId: number, items: Section[]): Section[] {
  if (items.length <= LONG || clauseId === lo.value?.clause || expanded.value.has(clauseId)) return items;
  return items.slice(0, SHORT);
}
function expand(clauseId: number) {
  expanded.value = new Set(expanded.value).add(clauseId);
}

function go(id: number) {
  caretToSection(id);
}

/** Jump into a subquery row's query: the cursor goes inside it, and this outline follows. */
function enter(it: Section) {
  if (it.targetFold) return caretToFold(it.targetFold);
  caretToSection(firstQuery(it.id) ?? it.id);
}
function hover(id: number | null) {
  state.hoverSection = id;
}

// Keep the current row in view.
watch(
  () => lo.value?.item ?? lo.value?.clause,
  async () => {
    await nextTick();
    const target = el.value?.querySelector(".row.cur") ?? el.value?.querySelector(".clause.cur > .heading");
    target?.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <section ref="el" class="local">
    <template v-if="lo">
      <div class="path">
        <template v-for="(q, i) in lo.path" :key="q">
          <span v-if="i > 0" class="sep">›</span>
          <button class="crumb" :class="{ cur: q === lo.query }" @click="go(q)">{{ unquote(queryLabel(q)) }}</button>
        </template>
      </div>
      <div v-if="arm" class="arm">
        <span>{{ arm.op }} · arm {{ arm.index + 1 }} of {{ arm.arms.length }}</span>
        <button class="nav" :disabled="arm.index === 0" title="Previous arm" @click="gotoArm(arm.index - 1)">‹</button>
        <button class="nav" :disabled="arm.index === arm.arms.length - 1" title="Next arm" @click="gotoArm(arm.index + 1)">›</button>
      </div>

      <div v-for="{ c, items } in clauses" :key="c.id" class="clause" :class="{ cur: c.id === lo.clause }">
        <div class="heading" @click="go(c.id)" @mouseenter="hover(c.id)" @mouseleave="hover(null)">
          <span class="h">{{ HEADING[c.kind] ?? c.label }}</span>
          <span v-if="!items.length && c.detail" class="h-detail">{{ c.detail.replace(/^\w+\s+/, "") }}</span>
          <span v-if="items.length > 1" class="count">{{ items.length }}</span>
        </div>

        <div v-if="items.length" class="grid" :class="c.kind">
          <div
            v-for="it in shown(c.id, items)"
            :key="it.id"
            class="row"
            :class="{ cur: it.id === lo.item }"
            :title="unquote(it.label)"
            @click="go(it.id)"
            @mouseenter="hover(it.id)"
            @mouseleave="hover(null)"
          >
            <!-- TABLES: join type + alias -->
            <span v-if="it.kind === 'source' || it.kind === 'join'" class="badge" :class="joinBadge(it)">{{ joinBadge(it) }}</span>
            <span class="text">{{ it.kind === "cond" || it.kind === "item" ? it.label : mid(unquote(it.label), 44) }}</span>
            <button v-if="isSubquery(it)" class="into" title="Go into this subquery" @click.stop="enter(it)">›</button>
          </div>
          <div v-if="shown(c.id, items).length < items.length" class="row more" @click="expand(c.id)">
            <span class="text">… {{ items.length - SHORT }} more</span>
          </div>
        </div>
      </div>
    </template>
    <p v-else class="hint">Click in the SQL to see the structure of the query around the cursor.</p>
  </section>
</template>

<style scoped>
.local {
  overflow: auto;
  padding: 6px 8px 16px;
  font-size: 12px;
}
.hint {
  color: var(--muted);
  margin: 4px;
  line-height: 1.5;
}
.path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1px;
  font-family: var(--mono);
  padding: 0 0 6px;
}
.crumb {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 1px 3px;
  border-radius: 3px;
}
.crumb:hover {
  background: var(--hov);
}
.crumb.cur {
  color: var(--fg);
  font-weight: 600;
}
.sep {
  color: var(--muted);
}
.arm {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  padding: 0 3px 8px;
}
.arm span {
  margin-right: auto;
}
.nav {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  border-radius: 3px;
  cursor: pointer;
  padding: 0 7px;
}
.nav:disabled {
  opacity: 0.35;
  cursor: default;
}

.clause {
  margin-bottom: 10px;
}
.heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.heading:hover {
  background: var(--hov);
}
.h {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.clause.cur .h {
  color: var(--accent);
}
.h-detail {
  font-family: var(--mono);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}

.grid {
  font-family: var(--mono);
  margin-top: 2px;
}
.row {
  display: flex;
  align-items: baseline;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.row:hover {
  background: var(--hov);
}
.row.cur {
  background: var(--hl);
}
.text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg);
}
.into {
  flex: 0 0 auto;
  margin-left: 6px;
  border: 1px solid var(--chip-border);
  background: var(--chip-bg);
  color: var(--chip-fg);
  border-radius: 3px;
  font: inherit;
  line-height: 14px;
  padding: 0 6px;
  cursor: pointer;
}
.into:hover {
  border-color: var(--accent);
  color: var(--fg);
}
.row.more .text {
  color: var(--accent);
  font-family: var(--sans);
}
.badge {
  flex: 0 0 auto;
  display: inline-block;
  width: 6ch;
  margin-right: 8px;
  font-size: 10px;
  line-height: 15px;
  text-transform: uppercase;
  text-align: center;
  border-radius: 3px;
  color: var(--muted);
  background: var(--kind-bg);
}
.badge.from {
  color: var(--fg);
}
.badge.left,
.badge.right {
  background: var(--k-rename);
  color: var(--chip-fg);
}
.badge.full,
.badge.cross {
  background: var(--k-case);
}
.badge.inner {
  background: var(--k-cast);
}
</style>
