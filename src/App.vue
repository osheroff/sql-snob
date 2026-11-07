<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  collapseAll,
  copyText,
  expandAll,
  focusUp,
  caretToken,
  load,
  mainLayout,
  moveCaret,
  reprint,
  reset,
  restoreSession,
  result,
  setFocus,
  state,
  toggle,
  toggleOutline,
} from "./state/store";
import Breadcrumbs from "./ui/Breadcrumbs.vue";
import Sidebar from "./ui/Sidebar.vue";
import ParseErrorView from "./ui/ParseErrorView.vue";
import PasteBox from "./ui/PasteBox.vue";
import SqlView from "./ui/SqlView.vue";

const copied = ref(false);
const showOpts = ref(false);
const showHelp = ref(false);

const stats = computed(() => {
  const r = result.value;
  if (!r) return "";
  const kb = (new Blob([state.sql]).size / 1024).toFixed(0);
  return `${kb} KB · ${Object.keys(r.folds).length} folds · ${mainLayout.value?.lines.length ?? 0} lines shown · parse ${state.ms.parse.toFixed(0)} ms, format ${state.ms.print.toFixed(0)} ms`;
});

async function copy() {
  await navigator.clipboard.writeText(copyText());
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}

function editSql() {
  reset();
}

function onOpt() {
  reprint();
}

/** Visible folds in screen order (for j/k). */
function visibleFolds(): string[] {
  const lay = mainLayout.value;
  if (!lay) return [];
  return [...lay.foldLine.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

function onKey(ev: KeyboardEvent) {
  if (state.status !== "ready") return;
  const t = ev.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") {
    if (ev.key === "Escape") t.blur();
    return;
  }
  // Caret movement, like an editor.
  const mod = ev.metaKey || ev.ctrlKey;
  const caretKeys: Record<string, Parameters<typeof moveCaret>[0]> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: mod ? "top" : "up",
    ArrowDown: mod ? "bottom" : "down",
    Home: mod ? "top" : "home",
    End: mod ? "bottom" : "end",
    PageUp: "pageUp",
    PageDown: "pageDown",
  };
  if (caretKeys[ev.key] && !ev.altKey && !ev.shiftKey) {
    moveCaret(caretKeys[ev.key]);
    ev.preventDefault();
    return;
  }
  if (mod || ev.altKey) return;
  const cur = state.cursor;
  switch (ev.key) {
    case "j":
    case "k": {
      const ids = visibleFolds();
      if (!ids.length) return;
      const i = cur ? ids.indexOf(cur) : -1;
      const next = ev.key === "j" ? Math.min(ids.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      state.cursor = ids[next];
      break;
    }
    case "Enter":
    case "o": {
      // A fold chip under the caret first, else the j/k fold cursor.
      const t = caretToken.value;
      if (t?.k === "fold" && t.fold) toggle(t.fold);
      else if (cur) toggle(cur);
      break;
    }
    case "f":
      if (cur) setFocus(cur);
      break;
    case "Escape":
    case "u":
      focusUp();
      break;
    case "E":
      expandAll();
      break;
    case "C":
      collapseAll();
      break;
    case "s":
      toggleOutline();
      break;
    case "?":
      showHelp.value = !showHelp.value;
      break;
    default:
      return;
  }
  ev.preventDefault();
}

// Restore the last query before child components read `state.sql`.
{
  const saved = restoreSession();
  if (saved.sql && saved.viewing) load(saved.sql, true);
  else state.sql = saved.sql;
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <PasteBox v-if="state.status === 'empty' || (state.status === 'loading' && !result)" />
  <ParseErrorView v-else-if="state.status === 'error'" @edit="editSql" />
  <div v-else class="app" :class="{ 'outline-closed': !state.outlineOpen }">
    <header class="top">
      <button class="logo" title="New query" @click="reset">sql-snob</button>
      <Breadcrumbs class="bc" />
      <div class="tools">
        <button class="btn" title="Expand everything in view (E)" @click="expandAll">Expand all</button>
        <button class="btn" title="Collapse everything in view (C)" @click="collapseAll">Collapse all</button>
        <button class="btn" title="Copy the formatted SQL of the current view, fully expanded" @click="copy">
          {{ copied ? "Copied" : "Copy SQL" }}
        </button>
        <div class="opts-wrap">
          <button class="btn" @click="showOpts = !showOpts">Options</button>
          <div v-if="showOpts" class="opts" @mouseleave="showOpts = false">
            <label><input v-model="state.opts.removeParens" type="checkbox" @change="onOpt" /> Remove redundant parentheses</label>
            <label><input v-model="state.opts.hideObviousCasts" type="checkbox" @change="onOpt" /> Hide obvious casts (<code>'x'::TEXT</code>)</label>
            <label><input v-model="state.opts.collapseAliases" type="checkbox" @change="onOpt" /> Collapse <code>"X" AS "X"</code></label>
            <label>
              Fold SELECT lists with ≥
              <input v-model.number="state.opts.columnFoldThreshold" type="number" min="1" max="999" class="num" @change="onOpt" />
              columns
            </label>
          </div>
        </div>
        <button class="btn" title="Keyboard shortcuts (?)" @click="showHelp = !showHelp">?</button>
      </div>
    </header>
    <Sidebar v-if="state.outlineOpen" class="outline" />
    <button v-else class="outline rail" title="Show sidebar (s)" @click="toggleOutline">
      <span class="rail-label">Outline · Context</span>
    </button>
    <SqlView class="main" />
    <footer class="status">
      <span>{{ stats }}</span>
      <span class="muted">Click a chip to expand · ⌘/Ctrl-click to focus · Esc to go up · ? for keys</span>
    </footer>
    <div v-if="showHelp" class="help" @click="showHelp = false">
      <div class="help-card" @click.stop>
        <h3>Keyboard</h3>
        <dl>
          <dt>j / k</dt><dd>Next / previous fold</dd>
          <dt>Enter / o</dt><dd>Expand or collapse the fold</dd>
          <dt>f</dt><dd>Focus the fold</dd>
          <dt>← → ↑ ↓</dt><dd>Move the cursor (Home / End, PageUp / PageDown, ⌘↑ / ⌘↓)</dd>
          <dt>u / Esc</dt><dd>Focus: up one level</dd>
          <dt>E / C</dt><dd>Expand all / collapse all in view</dd>
          <dt>s</dt><dd>Show / hide the sidebar</dd>
        </dl>
        <h3>Mouse</h3>
        <dl>
          <dt>Click chip</dt><dd>Expand</dd>
          <dt>Alt-click chip</dt><dd>Expand everything inside</dd>
          <dt>⌘/Ctrl-click chip</dt><dd>Focus</dd>
          <dt>Gutter ▾ / ⤢</dt><dd>Collapse / focus an open fold</dd>
          <dt>Outline</dt><dd>Click to show, double-click to focus</dd>
          <dt>This query</dt><dd>Click a part to move the cursor there</dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas:
    "top top"
    "outline main"
    "status status";
  height: 100%;
}
.app.outline-closed {
  grid-template-columns: 28px minmax(0, 1fr);
}
.rail {
  border: 0;
  border-right: 1px solid var(--border);
  background: var(--panel-bg);
  color: var(--muted);
  cursor: pointer;
  padding: 10px 0 0;
  display: flex;
  justify-content: center;
}
.rail:hover {
  color: var(--accent);
  background: var(--hov);
}
.rail-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.top {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-bg);
  min-width: 0;
}
.logo {
  font-weight: 700;
  letter-spacing: -0.02em;
  border: 0;
  background: none;
  color: var(--fg);
  cursor: pointer;
  font-size: 15px;
  padding: 0;
}
.bc { flex: 1; }
.tools { display: flex; gap: 6px; align-items: center; }
.opts-wrap { position: relative; }
.opts {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 10;
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  white-space: nowrap;
  box-shadow: 0 8px 24px var(--shadow);
}
.num { width: 4em; }
.outline { grid-area: outline; }
.main { grid-area: main; }
.status {
  grid-area: status;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 3px 12px;
  font-size: 11px;
  border-top: 1px solid var(--border);
  background: var(--panel-bg);
  white-space: nowrap;
  overflow: hidden;
}
.help {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  z-index: 20;
}
.help-card {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
  max-width: 520px;
}
.help-card h3 { margin: 4px 0 8px; font-size: 13px; }
dl { display: grid; grid-template-columns: 9em 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
dt { font-family: var(--mono); color: var(--accent); }
dd { margin: 0; }
@media (max-width: 800px) {
  .app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: "top" "main" "status";
  }
  .outline { display: none; }
}
</style>
