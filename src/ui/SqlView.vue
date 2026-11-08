<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { lineWidth } from "../core/layout";
import { nameKey } from "../core/model";
import {
  caretPos,
  expandDeep,
  folds,
  identMatches,
  localOutline,
  mainLayout,
  moveCaret,
  sectionTags,
  setCaretAt,
  setFocus,
  state,
  toggle,
} from "../state/store";

const LINE_H = 20;
const GUTTER_PX = 20;
const BUFFER = 30;
/** Empty space below the last line. */
const BOTTOM_PAD = 30;

const el = ref<HTMLElement>();
const sizer = ref<HTMLElement>();
const scrollTop = ref(0);
const viewH = ref(600);
/** Width of one character. Everything (chips included) sits on this monospace grid. */
const charW = ref(7.8);
/** Fold that is flashing after a reveal, by id, so it follows layout re-flows. */
const flash = ref<string | null>(null);
const flashLine = computed(() => (flash.value ? (mainLayout.value?.foldLine.get(flash.value) ?? -1) : -1));
let flashTimer: number | undefined;

const lines = computed(() => mainLayout.value?.lines ?? []);
const maxCols = computed(() => lines.value.reduce((m, l) => Math.max(m, lineWidth(l)), 0));

const visible = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / LINE_H) - BUFFER);
  const end = Math.min(lines.value.length, Math.ceil((scrollTop.value + viewH.value) / LINE_H) + BUFFER);
  const out = [];
  for (let n = start; n < end; n++) out.push({ n, l: lines.value[n] });
  return { start, rows: out };
});

const cursorLine = computed(() => (state.cursor ? (mainLayout.value?.foldLine.get(state.cursor) ?? -1) : -1));

/** Tokens of the outline item the caret is in, and of the item hovered in the outline. */
const curTags = computed(() => sectionTags(localOutline.value?.item ?? null));
const hoverTags = computed(() => sectionTags(state.hoverSection));

/** Is this token a usage of the identifier under the caret (in the current block)? */
function sameIdent(t: { k: string; s: string; tag?: string }): boolean {
  const m = identMatches.value;
  return !!m && t.k === "id" && !!t.tag && m.tags.has(t.tag) && nameKey(t.s) === m.key;
}

function onScroll() {
  scrollTop.value = el.value!.scrollTop;
}

function measure() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:13px";
  probe.textContent = "M".repeat(100);
  el.value!.appendChild(probe);
  charW.value = probe.getBoundingClientRect().width / 100 || 7.8;
  probe.remove();
}

let ro: ResizeObserver | undefined;
let resizeTimer: number | undefined;
function fitWidth() {
  const e = el.value!;
  state.width = Math.max(40, Math.floor((e.clientWidth - GUTTER_PX - 16) / charW.value));
}

onMounted(() => {
  measure();
  fitWidth(); // right away, so the first layout already has the real width
  ro = new ResizeObserver(() => {
    const e = el.value!;
    viewH.value = e.clientHeight;
    state.viewLines = Math.floor(e.clientHeight / LINE_H);
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(fitWidth, 60);
  });
  ro.observe(el.value!);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener("keydown", onKey);
});

function scrollIntoView(line: number, col?: number, center = false) {
  const e = el.value;
  if (!e) return;
  const top = line * LINE_H;
  if (center) {
    if (top < e.scrollTop + LINE_H * 2 || top > e.scrollTop + e.clientHeight - LINE_H * 3) {
      e.scrollTop = Math.max(0, top - e.clientHeight / 3);
    }
  } else if (top < e.scrollTop + LINE_H) {
    e.scrollTop = Math.max(0, top - LINE_H);
  } else if (top > e.scrollTop + e.clientHeight - LINE_H * 2) {
    e.scrollTop = top - e.clientHeight + LINE_H * 2;
  }
  if (col !== undefined) {
    const x = GUTTER_PX + col * charW.value;
    if (x < e.scrollLeft + GUTTER_PX) e.scrollLeft = Math.max(0, x - GUTTER_PX - 40);
    else if (x > e.scrollLeft + e.clientWidth - 20) e.scrollLeft = x - e.clientWidth + 60;
  }
}

// Scroll to a fold revealed from the outline, and flash it.
watch(
  () => [mainLayout.value, state.reveal] as const,
  ([lay, rev]) => {
    if (!lay || !rev) return;
    const line = lay.foldLine.get(rev.id);
    state.reveal = null;
    if (line === undefined) return;
    scrollIntoView(line, undefined, true);
    flash.value = rev.id;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => (flash.value = null), 900);
  },
  { flush: "post" },
);

// Keep the caret and the keyboard fold cursor on screen.
watch(caretPos, (p, old) => {
  if (!p || (p.line === old?.line && p.col === old?.col)) return;
  // A jump (from the outline, PageDown, ...) centers the caret; small moves just keep it on screen.
  const jump = !old || Math.abs(p.line - old.line) > state.viewLines / 2;
  scrollIntoView(p.line, p.col, jump);
});
watch(cursorLine, (line) => line >= 0 && scrollIntoView(line));

function onClick(ev: MouseEvent) {
  const t = ev.target as HTMLElement;
  const g = t.closest<HTMLElement>("[data-toggle]");
  if (g) return toggle(g.dataset.toggle!);

  const chip = t.closest<HTMLElement>("[data-fold]");
  if (chip) {
    const id = chip.dataset.fold!;
    state.cursor = id;
    placeCaret(ev);
    if (ev.metaKey || ev.ctrlKey) return setFocus(id);
    return ev.altKey ? expandDeep(id) : toggle(id);
  }
  // A drag selects text; a plain click places the caret.
  if (!window.getSelection()?.isCollapsed) return;
  placeCaret(ev);
}

/** Caret from mouse coordinates: everything is on a monospace grid, so this is arithmetic. */
function placeCaret(ev: MouseEvent) {
  const s = sizer.value;
  if (!s) return;
  const r = s.getBoundingClientRect();
  const line = Math.floor((ev.clientY - r.top) / LINE_H);
  const x = ev.clientX - r.left - GUTTER_PX;
  if (x < 0 || line < 0 || line >= lines.value.length) return;
  setCaretAt(line, Math.round(x / charW.value), false, true);
  el.value?.focus({ preventScroll: true });
}

/** Arrow keys move the caret, like an editor (only while the SQL view has the focus). */
function onKey(ev: KeyboardEvent) {
  const a = document.activeElement;
  if (a && a !== document.body && !el.value?.contains(a)) return; // typing elsewhere
  const mod = ev.metaKey || ev.ctrlKey;
  const keys: Record<string, Parameters<typeof moveCaret>[0]> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: mod ? "top" : "up",
    ArrowDown: mod ? "bottom" : "down",
    Home: mod ? "top" : "home",
    End: mod ? "bottom" : "end",
    PageUp: "pageUp",
    PageDown: "pageDown",
  };
  if (!keys[ev.key] || ev.altKey || ev.shiftKey) return;
  moveCaret(keys[ev.key]);
  ev.preventDefault();
}

/** A collapsed column list on this line: its toggle goes in the gutter. */
function closedCols(l: { tokens: { k: string; fold?: string }[] }): string | undefined {
  return l.tokens.find((t) => t.k === "fold" && t.fold && folds.value[t.fold]?.kind === "columns")?.fold;
}

function chipTitle(id: string): string {
  const f = folds.value[id];
  if (!f) return "";
  return `${f.name} (${f.kind})\nClick: expand · Alt-click: expand all inside${f.kind === "columns" ? "" : "\n⌘/Ctrl-click: focus"}`;
}
</script>

<template>
  <div ref="el" class="sqlview" tabindex="0" @scroll="onScroll" @click="onClick">
    <div
      ref="sizer"
      class="sizer"
      :style="{ height: lines.length * LINE_H + BOTTOM_PAD + 'px', minWidth: `${GUTTER_PX + (maxCols + 4) * charW}px` }"
    >
      <div class="rows" :style="{ transform: `translateY(${visible.start * LINE_H}px)` }">
        <div
          v-for="{ n, l } in visible.rows"
          :key="n"
          class="row"
          :class="{ flash: n === flashLine, cursor: n === cursorLine, 'caret-line': n === caretPos?.line }"
        >
          <span class="gutter">
            <button v-if="l.opens" class="g-btn" :data-toggle="l.opens[0]" :title="`Collapse ${folds[l.opens[0]]?.name}`">▾</button>
            <button v-else-if="closedCols(l)" class="g-btn" :data-toggle="closedCols(l)" :title="`Expand ${folds[closedCols(l)!]?.name}`">▸</button>
          </span>
          <span class="code" :style="{ paddingLeft: l.indent * charW + 'px' }"><template v-for="(t, i) in l.tokens" :key="i"><span
                v-if="t.k === 'fold'"
                class="chip"
                :class="[folds[t.fold!]?.kind, { cur: t.fold === state.cursor, 'cur-sec': t.tag && curTags.has(t.tag), hov: t.tag && hoverTags.has(t.tag) }]"
                :data-fold="t.fold"
                :title="chipTitle(t.fold!)"
              ><template v-if="folds[t.fold!]?.kind === 'columns'">{{ "\u00a0" + t.s + "\u00a0" }}</template><template v-else><span class="tri">▸</span> {{ t.s }}</template></span><span
                v-else
                :class="['t-' + t.k, { 'cur-sec': t.tag && curTags.has(t.tag), hov: t.tag && hoverTags.has(t.tag), 'same-id': sameIdent(t) }]"
              >{{ t.s }}</span></template></span>
        </div>
      </div>
      <div
        v-if="caretPos"
        class="caret"
        :style="{ top: caretPos.line * LINE_H + 2 + 'px', left: GUTTER_PX + caretPos.col * charW - 1 + 'px' }"
      />
    </div>
  </div>
</template>

<style scoped>
.sqlview {
  overflow: auto;
  height: 100%;
  position: relative;
  background: var(--bg);
  outline: none;
  cursor: text;
}
.sizer {
  position: relative;
}
.rows {
  position: absolute;
  inset: 0 0 auto 0;
  will-change: transform;
}
.row {
  height: 20px;
  line-height: 20px;
  display: flex;
  white-space: pre;
}
.row.caret-line {
  background: var(--cursor-bg);
}
.row.flash {
  animation: flash 0.9s ease-out;
}
@keyframes flash {
  from {
    background: var(--flash);
  }
  to {
    background: transparent;
  }
}
.gutter {
  flex: 0 0 20px;
  display: flex;
  gap: 2px;
  justify-content: flex-end;
  padding-right: 2px;
  user-select: none;
  cursor: default;
}
.g-btn {
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  line-height: 20px;
}
.g-btn:hover {
  color: var(--accent);
}
.code {
  font-family: var(--mono);
  font-size: 13px;
}
/* Chips keep exactly `label.length + 2` columns: no padding, margin or border. */
.chip {
  border-radius: 3px;
  background: var(--chip-bg);
  color: var(--chip-fg);
  box-shadow: inset 0 0 0 1px var(--chip-border);
  cursor: pointer;
}
.chip .tri {
  display: inline-block;
  width: 1ch;
  text-align: center;
}
.chip:hover {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.chip.columns {
  background: var(--chip-cols-bg);
  color: var(--chip-cols-fg);
}
.chip.cur {
  outline: 2px solid var(--accent);
}
.cur-sec {
  background: var(--cur-sec);
}
.hov {
  background: var(--hl);
}
/* Usages of the identifier under the caret: only while the SQL view has the focus. */
.sqlview:focus-within .same-id {
  background: var(--same-id);
  box-shadow: 0 0 0 1px var(--same-id-border);
  border-radius: 2px;
}
.caret {
  position: absolute;
  width: 2px;
  height: 16px;
  background: var(--accent);
  pointer-events: none;
  animation: blink 1.1s steps(1) infinite;
}
/* Without the focus the caret still blinks, faintly. */
.sqlview:not(:focus) .caret {
  animation-name: blink-faint;
}
@keyframes blink-faint {
  0% {
    opacity: 0.4;
  }
  50% {
    opacity: 0;
  }
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.t-kw { color: var(--kw); }
.t-id { color: var(--id); }
.t-fn { color: var(--fn); }
.t-str { color: var(--str); }
.t-num { color: var(--num); }
.t-op { color: var(--op); }
.t-com { color: var(--com); font-style: italic; }
.t-param { color: var(--param); }
.t-plain { color: var(--fg); }
</style>
