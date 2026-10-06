import "clsx";
import { s as stores } from "./client.js";
import { x as writable, h as get } from "./exports.js";
import { a as attr, d as bind_props, b as attr_class, h as stringify, f as ensure_array_like, g as store_get, u as unsubscribe_stores } from "./index.js";
import { e as escape_html, o as onDestroy, c as createEventDispatcher } from "./index-client.js";
import { N as fallback } from "./environment.js";
import { k as can } from "./capabilities.js";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import diff from "highlight.js/lib/languages/diff";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import DOMPurify from "dompurify";
function html(value) {
  var html2 = String(value ?? "");
  var open = "<!---->";
  return open + html2 + "<!---->";
}
const getStores = () => {
  const stores$1 = stores;
  return {
    /** @type {typeof page} */
    page: {
      subscribe: stores$1.page.subscribe
    },
    /** @type {typeof navigating} */
    navigating: {
      subscribe: stores$1.navigating.subscribe
    },
    /** @type {typeof updated} */
    updated: stores$1.updated
  };
};
const page = {
  subscribe(fn) {
    const store2 = getStores().page;
    return store2.subscribe(fn);
  }
};
const connection = writable("offline");
const latency = writable(0);
const KEY = "ocrc.sidePane.v1";
const MAX_TABS = 12;
const HOMES = [
  { homeId: "tasks", title: "任务" },
  { homeId: "files", title: "文件" },
  { homeId: "subs", title: "子代理" },
  { homeId: "skills", title: "Skills" },
  { homeId: "schedules", title: "定时任务" },
  { homeId: "mcp", title: "MCP" }
];
const HOME_IDS = new Set(HOMES.map((h) => h.homeId));
const HOME_MIGRATE = { config: "schedules" };
function validTab(t) {
  if (!t || typeof t !== "object") return false;
  const x = t;
  if (typeof x.id !== "string" || typeof x.title !== "string") return false;
  switch (x.kind) {
    case "home":
      return typeof x.homeId === "string" && HOME_IDS.has(x.homeId);
    case "subagent":
      return typeof x.childId === "string";
    case "file":
      return typeof x.path === "string" && typeof x.directory === "string";
    case "tool":
      return typeof x.sessionId === "string" && typeof x.messageId === "string" && typeof x.partId === "string";
    case "git":
      return true;
    case "sidechat":
      return typeof x.childId === "string";
    default:
      return false;
  }
}
function loadState(raw) {
  try {
    const r = raw;
    let tabs = (Array.isArray(r.tabs) ? r.tabs : []).map((t) => {
      const x = t;
      if (x?.kind === "home" && x.homeId === "config") {
        return { ...t, homeId: "schedules", title: "定时任务", id: "schedules" };
      }
      return t;
    }).filter(validTab);
    let activeId = typeof r.activeId === "string" ? r.activeId : "";
    if (HOME_MIGRATE[activeId]) activeId = HOME_MIGRATE[activeId];
    if (activeId && HOME_IDS.has(activeId) && !tabs.some((t) => t.id === activeId)) {
      const home = HOMES.find((h) => h.homeId === activeId);
      tabs = [...tabs, { id: home.homeId, kind: "home", title: home.title, homeId: home.homeId }];
    }
    if (!tabs.some((t) => t.id === activeId)) activeId = "";
    return { tabs: tabs.slice(-MAX_TABS), activeId };
  } catch {
    return { tabs: [], activeId: "" };
  }
}
function load() {
  try {
    return loadState(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return loadState({});
  }
}
function persist(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
  }
}
const store = writable(load());
store.subscribe(persist);
function openPaneTab(tab) {
  store.update((s) => {
    const idx = s.tabs.findIndex((t) => t.id === tab.id);
    const tabs = idx === -1 ? [...s.tabs, tab].slice(-MAX_TABS) : s.tabs.map((t) => t.id === tab.id ? tab : t);
    return { tabs, activeId: tab.id };
  });
}
function openHome(homeId) {
  const home = HOMES.find((h) => h.homeId === homeId);
  openPaneTab({ id: home.homeId, kind: "home", title: home.title, homeId });
}
function closePaneTab(id) {
  store.update((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return s;
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeId = s.activeId;
    if (activeId === id) {
      activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? "";
    }
    return { tabs, activeId };
  });
}
function reorderPaneTab(from, to) {
  if (from === to || from < 0 || to < 0) return;
  store.update((s) => {
    if (from >= s.tabs.length || to >= s.tabs.length) return s;
    const tabs = [...s.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    return { ...s, tabs };
  });
}
function activatePane(id) {
  store.update((s) => ({ ...s, activeId: id }));
}
function resetPane() {
  store.set({ tabs: [], activeId: "" });
}
const sidePane = { subscribe: store.subscribe, openPaneTab, openHome, closePaneTab, reorderPaneTab, activatePane, resetPane };
const RAIL_OPEN_KEY = "ocrc.railOpen";
function persistedRailOpen() {
  let initial = true;
  try {
    initial = localStorage.getItem(RAIL_OPEN_KEY) !== "0";
  } catch {
  }
  const store2 = writable(initial);
  store2.subscribe((v) => {
    try {
      localStorage.setItem(RAIL_OPEN_KEY, v ? "1" : "0");
    } catch {
    }
  });
  return store2;
}
const leftPanelOpen = persistedRailOpen();
const plusMenuOpen = writable(false);
const newSessionOpen = writable(false);
const channelsOpen = writable(false);
const inspectorOpen = writable(false);
const feedResyncing = writable(false);
const sessionBooting = writable(false);
const composerDraft = writable(void 0);
const composerDrafts = /* @__PURE__ */ new Map();
function saveComposerDraft(sid, text) {
  if (!sid) return;
  if (text) composerDrafts.set(sid, text);
  else composerDrafts.delete(sid);
}
function takeComposerDraft(sid) {
  if (!sid) return "";
  const d = composerDrafts.get(sid) ?? "";
  composerDrafts.delete(sid);
  return d;
}
const composerEmpty = writable(true);
const THEME_KEY = "ocrc-theme";
function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  } catch {
  }
  return "auto";
}
function applyThemeMeta(t) {
  const c = t === "light" ? "#faf9f6" : "#0d0d0d";
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", c));
}
const themeMode = writable(initialTheme());
const theme = writable(initialTheme() === "dark" ? "dark" : "light");
function resolvedFrom(mode) {
  if (mode !== "auto") return mode;
  if (typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}
function applyMode(mode) {
  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }
  const resolved = resolvedFrom(mode);
  theme.set(resolved);
  applyThemeMeta(resolved);
}
if (typeof document !== "undefined") {
  const mode = initialTheme();
  applyMode(mode);
  themeMode.set(mode);
  if (typeof matchMedia !== "undefined") {
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
      if (get(themeMode) === "auto") applyMode("auto");
    });
  }
}
function Icon($$renderer, $$props) {
  const PATHS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    "caret-down": '<path d="M6 9l6 6 6-6"/>',
    "caret-right": '<path d="M9 6l6 6-6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    refresh: '<path d="M20.5 15a9 9 0 1 1-2.2-9.5L21 8"/><path d="M21 3v5h-5"/>',
    alert: '<path d="M12 3l10 17H2L12 3z"/><path d="M12 10v4"/><path d="M12 17.6v.4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2 12h3M19 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
    bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    "arrow-down": '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
    // side-pane tab kinds (ZCode SidePaneTabIcon register)
    tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    files: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="12" cy="4" r="2"/><path d="M9 14h.01M15 14h.01"/><path d="M9 17h6"/>',
    skill: '<path d="M12 2l2.4 6.2L21 9l-5 4.4L17.5 21 12 17.6 6.5 21 8 13.4 3 9l6.6-.8z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .9-8.9A7 7 0 0 0 5 12.5 4 4 0 0 0 6.5 19z"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6H14a4 4 0 0 1 4 4v0"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    terminal: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    tool: '<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6l-2.8 2.8-2.2-2.2z"/>',
    brain: '<path d="M9.5 2.5a3 3 0 0 0-3 3 3 3 0 0 0-2 2.8c0 .8.3 1.6.8 2.1A3.2 3.2 0 0 0 4 13a3 3 0 0 0 1.7 2.7 3 3 0 0 0 3 3.3c.8 0 1.6-.3 2.3-.9V4.6a3 3 0 0 0-1.5-2.1z"/><path d="M14.5 2.5a3 3 0 0 1 3 3 3 3 0 0 1 2 2.8c0 .8-.3 1.6-.8 2.1A3.2 3.2 0 0 1 20 13a3 3 0 0 1-1.7 2.7 3 3 0 0 1-3 3.3c-.8 0-1.6-.3-2.3-.9"/>'
  };
  let name = fallback($$props["name"], "");
  let size = fallback($$props["size"], 16);
  $$renderer.push(`<svg${attr("width", size)}${attr("height", size)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${html(PATHS[name] ?? "")}</svg>`);
  bind_props($$props, { name, size });
}
function CardUser($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let card = $$props["card"];
    $$renderer2.push(`<div class="card user svelte-2ec03f">${escape_html(card.text)}</div>`);
    bind_props($$props, { card });
  });
}
function CardThinking($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let card = $$props["card"];
    $$renderer2.push(`<div class="thinking-row svelte-1n9pz5q"><span class="toggle mono svelte-1n9pz5q"><span class="caret svelte-1n9pz5q" aria-hidden="true">`);
    Icon($$renderer2, { name: "caret-right", size: 11 });
    $$renderer2.push(`<!----></span> reasoning</span> `);
    if (card.showStop) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="stop svelte-1n9pz5q">Stop</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { card });
  });
}
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
let skipAutoHighlight = false;
function setStreamHighlight(skip) {
  skipAutoHighlight = skip;
}
marked.use(markedHighlight({
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    if (skipAutoHighlight) {
      return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    return hljs.highlightAuto(code).value;
  }
}));
const MAX_MARKDOWN_LEN = 6e4;
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
const PURIFY_CONFIG = {
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
  FORBID_ATTR: ["style"]
};
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderMarkdown(text) {
  if (text.length > MAX_MARKDOWN_LEN) {
    return `<pre class="raw">${escapeHtml(text)}</pre>`;
  }
  try {
    return DOMPurify.sanitize(marked.parse(text, { async: false }), PURIFY_CONFIG);
  } catch {
    return `<pre class="raw">${escapeHtml(text)}</pre>`;
  }
}
function MarkdownView($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let src = $$props["src"];
    let throttle = fallback($$props["throttle"], false);
    let streaming = fallback($$props["streaming"], false);
    let html$1 = "";
    let lastApplied;
    let raf = 0;
    let pending = "";
    function decorateCodeBlocks(wrap) {
      const blocks = Array.from(wrap.querySelectorAll("pre > code"));
      blocks.forEach((code) => {
        const pre = code.parentElement;
        if (!pre || pre.parentElement?.classList.contains("code-block")) return;
        const cls = Array.from(code.classList).find((c) => c.startsWith("language-"));
        const lang = cls ? cls.slice(9) : "";
        const block = document.createElement("div");
        block.className = "code-block";
        const header = document.createElement("div");
        header.className = "code-header";
        const square = document.createElement("span");
        square.className = "code-square";
        square.setAttribute("aria-hidden", "true");
        const tag = document.createElement("span");
        tag.className = "code-lang mono";
        tag.textContent = lang;
        header.appendChild(square);
        header.appendChild(tag);
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "code-copy mono";
        copy.textContent = "Copy";
        header.appendChild(copy);
        block.appendChild(header);
        pre.parentNode?.insertBefore(block, pre);
        block.appendChild(pre);
      });
    }
    function apply(text) {
      if (text === lastApplied) return;
      lastApplied = text;
      setStreamHighlight(streaming);
      const wrap = document.createElement("div");
      wrap.innerHTML = renderMarkdown(text);
      decorateCodeBlocks(wrap);
      {
        html$1 = wrap.innerHTML;
      }
    }
    let lastParsedAt = 0;
    let gapTimer;
    const parseGap = (text) => text.length > 1e5 ? 250 : text.length > 4e4 ? 120 : 45;
    function schedule(text) {
      if (!throttle || typeof requestAnimationFrame === "undefined") {
        if (gapTimer) {
          clearTimeout(gapTimer);
          gapTimer = void 0;
        }
        setStreamHighlight(streaming);
        apply(text);
        return;
      }
      pending = text;
      if (raf || gapTimer) return;
      const wait = Math.max(0, parseGap(text) - (Date.now() - lastParsedAt));
      if (wait === 0) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          lastParsedAt = Date.now();
          apply(pending);
        });
      } else {
        gapTimer = setTimeout(
          () => {
            gapTimer = void 0;
            if (!raf) raf = requestAnimationFrame(() => {
              raf = 0;
              lastParsedAt = Date.now();
              apply(pending);
            });
          },
          wait
        );
      }
    }
    onDestroy(() => {
      if (raf) cancelAnimationFrame(raf);
      if (gapTimer) {
        clearTimeout(gapTimer);
        gapTimer = void 0;
      }
    });
    onDestroy(() => {
      if (raf) cancelAnimationFrame(raf);
    });
    schedule(src);
    schedule(src);
    $$renderer2.push(`<div${attr_class("md svelte-180jyqg", void 0, { "streaming": streaming })} role="presentation">${html(html$1)}</div>`);
    bind_props($$props, { src, throttle, streaming });
  });
}
const FG = {
  30: "#555",
  31: "#e0796b",
  32: "#6cc08b",
  33: "#e0b341",
  34: "#7cafc2",
  35: "#b48cf0",
  36: "#4ec9b0",
  37: "#f2f0ec",
  90: "#8d877c",
  91: "#f09080",
  92: "#8dd8a4",
  93: "#f0c860",
  94: "#90c5dd",
  95: "#c9a8f8",
  96: "#70dcc8",
  97: "#ffffff"
};
function xterm256(n) {
  if (n < 16) {
    const base = n < 8 ? 30 + n : 90 + (n - 8);
    return FG[base] ?? "#ccc";
  }
  if (n < 232) {
    const v = n - 16;
    const ch = (x) => x === 0 ? 0 : 55 + 40 * x;
    return `rgb(${ch(Math.floor(v / 36))},${ch(Math.floor(v % 36 / 6))},${ch(v % 6)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}
function ansiToHtml(raw) {
  let s = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (m) => m.endsWith("m") ? m : "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\][^\x1b]*\x1b\\/g, "");
  let open = 0;
  const out = [];
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      out.push(part);
      continue;
    }
    const codes = m[1].split(";").filter(Boolean).map(Number);
    if (codes.length === 0) codes.push(0);
    const css2 = [];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        while (open > 0) {
          out.push("</span>");
          open--;
        }
      } else if (c === 38 || c === 48) {
        const mode = codes[i + 1];
        if (mode === 5) {
          const color = xterm256(codes[i + 2] ?? 0);
          css2.push(c === 38 ? `color:${color}` : `background-color:${color}`);
          i += 2;
        } else if (mode === 2) {
          const rgb = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          css2.push(c === 38 ? `color:${rgb}` : `background-color:${rgb}`);
          i += 4;
        }
      } else if (c === 1) css2.push("font-weight:bold");
      else if (c === 2) css2.push("opacity:0.7");
      else if (c === 3) css2.push("font-style:italic");
      else if (c === 4) css2.push("text-decoration:underline");
      else if (FG[c]) css2.push(`color:${FG[c]}`);
    }
    if (css2.length) {
      out.push(`<span style="${css2.join(";")}">`);
      open++;
    }
  }
  while (open > 0) {
    out.push("</span>");
    open--;
  }
  return out.join("");
}
function TerminalBlock($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let lines, collapsible, expanded, shown, glyph;
    let text = $$props["text"];
    let tool = fallback($$props["tool"], "");
    let status = fallback($$props["status"], "done");
    let dur = fallback($$props["dur"], void 0);
    let adds = fallback($$props["adds"], void 0);
    let dels = fallback($$props["dels"], void 0);
    const MAX_LINES = 20;
    let userExpanded = false;
    let html$1 = "";
    let lastApplied;
    let raf = 0;
    let pending = "";
    function apply(s) {
      if (s === lastApplied) return;
      lastApplied = s;
      html$1 = ansiToHtml(s);
    }
    onDestroy(() => {
      if (raf) cancelAnimationFrame(raf);
    });
    function fmtDur(s) {
      if (s == null) return "";
      if (s < 1) return `${(s * 1e3).toFixed(0)}ms`;
      return `${s.toFixed(1)}s`;
    }
    lines = text.split("\n");
    collapsible = lines.length > MAX_LINES;
    expanded = status === "running" || userExpanded;
    shown = collapsible && !expanded ? lines.slice(0, MAX_LINES).join("\n") : text;
    {
      const s = shown;
      if (status === "running" && typeof requestAnimationFrame !== "undefined") {
        pending = s;
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          apply(pending);
        });
      } else {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        apply(s);
      }
    }
    glyph = status === "done" ? "✓" : status === "running" ? "●" : "✗";
    $$renderer2.push(`<div${attr_class(`term ${stringify(status)}`, "svelte-dcl78h")}><div class="term-head svelte-dcl78h"><span class="glyph svelte-dcl78h" aria-hidden="true">${escape_html(glyph)}</span> <span class="tname mono svelte-dcl78h">${escape_html(tool)}</span> `);
    if (adds || dels) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="diff mono svelte-dcl78h">`);
      if (adds) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="add svelte-dcl78h">+${escape_html(adds)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (dels) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="del svelte-dcl78h">−${escape_html(dels)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (status === "running") {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="shimmer svelte-dcl78h" aria-hidden="true"></span>`);
    } else if (dur != null) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<span class="dur mono svelte-dcl78h">${escape_html(fmtDur(dur))}</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> <div class="term-body mono svelte-dcl78h">${html(html$1)}</div> `);
    if (collapsible && status !== "running") {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="toggle mono svelte-dcl78h">${escape_html(expanded ? "▴ show less" : `▾ show more · ${lines.length - MAX_LINES} more lines`)}</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { text, tool, status, dur, adds, dels });
  });
}
function ToolCallList($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let typed, shown, total, done, running;
    let tools = $$props["tools"];
    let sessionId = fallback($$props["sessionId"], void 0);
    const LIMIT = 12;
    const INLINE_MAX = 100;
    const longIdx = /* @__PURE__ */ new Set();
    function isLong(t, i) {
      const key = `${t.messageId ?? ""}:${t.partId ?? "#" + i}`;
      if (longIdx.has(key)) return true;
      const a = t.args ?? "";
      const long = a.includes("\n") || a.length > INLINE_MAX;
      if (long) longIdx.add(key);
      return long;
    }
    function fmtDur(s) {
      if (s == null) return "";
      if (s < 1) return `${(s * 1e3).toFixed(0)}ms`;
      return `${s.toFixed(1)}s`;
    }
    const openable = (t) => !!(sessionId && t.partId && t.messageId);
    typed = tools;
    shown = typed.slice(0, LIMIT);
    total = typed.length;
    done = typed.filter((t) => t.status === "done").length;
    running = typed.filter((t) => t.status === "running").length;
    if (tools.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="execution svelte-on906i"><div class="header svelte-on906i"><span class="label mono svelte-on906i">EXECUTION</span> <span class="rule svelte-on906i" aria-hidden="true"></span> <span class="count mono svelte-on906i">${escape_html(done)}/${escape_html(total)} steps${escape_html(running > 0 ? ` · ${running} 运行中` : "")}</span></div> <div class="rows svelte-on906i"><!--[-->`);
      const each_array = ensure_array_like(shown);
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let t = each_array[i];
        if (isLong(t, i)) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<button class="bare svelte-on906i"${attr("disabled", !openable(t), true)}${attr("title", openable(t) ? "查看完整输出" : void 0)}>`);
          TerminalBlock($$renderer2, {
            text: t.args,
            tool: t.tool,
            status: t.status,
            dur: t.dur,
            adds: t.adds,
            dels: t.dels
          });
          $$renderer2.push(`<!----></button>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<button${attr_class(`row ${stringify(t.status)} bare`, "svelte-on906i")}${attr("disabled", !openable(t), true)}${attr("title", openable(t) ? "查看完整输出" : void 0)}><div class="row-main svelte-on906i"><span class="status svelte-on906i" aria-hidden="true"></span> <span class="sr-only svelte-on906i">${escape_html(t.status)}</span> <span class="name mono svelte-on906i">${escape_html(t.tool)}</span> `);
          if (t.tool === "bash") {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<span class="ps1 mono svelte-on906i" aria-hidden="true">$</span>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--> <span class="arg mono svelte-on906i">${escape_html(t.args)}</span> `);
          if (t.adds || t.dels) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<span class="diff mono svelte-on906i">`);
            if (t.adds) {
              $$renderer2.push("<!--[0-->");
              $$renderer2.push(`<span class="add svelte-on906i">+${escape_html(t.adds)}</span>`);
            } else {
              $$renderer2.push("<!--[-1-->");
            }
            $$renderer2.push(`<!--]--> `);
            if (t.dels) {
              $$renderer2.push("<!--[0-->");
              $$renderer2.push(`<span class="del svelte-on906i">−${escape_html(t.dels)}</span>`);
            } else {
              $$renderer2.push("<!--[-1-->");
            }
            $$renderer2.push(`<!--]--></span>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--> `);
          if (t.status === "running") {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<span class="shimmer svelte-on906i" aria-hidden="true"></span>`);
          } else if (t.dur != null) {
            $$renderer2.push("<!--[1-->");
            $$renderer2.push(`<span class="dur mono svelte-on906i">${escape_html(fmtDur(t.dur))}</span>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--> `);
          if (openable(t)) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<span class="go svelte-on906i" aria-hidden="true">↗</span>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></div></button>`);
        }
        $$renderer2.push(`<!--]-->`);
      }
      $$renderer2.push(`<!--]--> `);
      if (typed.length > LIMIT && true) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="more mono svelte-on906i">… ${escape_html(typed.length - LIMIT)} more</button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    bind_props($$props, { tools, sessionId });
  });
}
function CardStreaming($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let segments, reasoningLive;
    let card = $$props["card"];
    let thinkOpen = false;
    segments = (() => {
      const out = [];
      for (const b of card.blocks) {
        if (b.type === "text") {
          const last = out[out.length - 1];
          if (last?.kind === "text") last.text += b.text;
          else out.push({ kind: "text", text: b.text });
        } else if (b.type === "tool") {
          const last = out[out.length - 1];
          const t = {
            tool: b.tool,
            args: b.args,
            status: b.status,
            partId: b.partId,
            messageId: b.messageId
          };
          if (last?.kind === "tools") last.tools.push(t);
          else out.push({ kind: "tools", tools: [t] });
        } else if (b.type === "reasoning") {
          const last = out[out.length - 1];
          if (last?.kind === "reasoning") last.text += b.text;
          else out.push({ kind: "reasoning", text: b.text });
        }
      }
      return out;
    })();
    reasoningLive = segments.length > 0 && segments[segments.length - 1].kind === "reasoning";
    $$renderer2.push(`<div class="card streaming svelte-l1yd1q"><!--[-->`);
    const each_array = ensure_array_like(segments);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let seg = each_array[$$index];
      if (seg.kind === "text") {
        $$renderer2.push("<!--[0-->");
        if (seg.text.trim()) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="text svelte-l1yd1q">`);
          MarkdownView($$renderer2, { src: seg.text, throttle: true, streaming: true });
          $$renderer2.push(`<!----></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]-->`);
      } else if (seg.kind === "tools") {
        $$renderer2.push("<!--[1-->");
        ToolCallList($$renderer2, { tools: seg.tools, sessionId: card.sessionId });
      } else if (seg.text.trim()) {
        $$renderer2.push("<!--[2-->");
        $$renderer2.push(`<div class="think svelte-l1yd1q"><button class="think-head svelte-l1yd1q"${attr("aria-expanded", thinkOpen)}>`);
        if (reasoningLive) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="think-dot svelte-l1yd1q" aria-hidden="true"></span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <span class="think-label svelte-l1yd1q">${escape_html(reasoningLive ? "思考中…" : "思考过程")}</span> <svg${attr_class("think-caret svelte-l1yd1q", void 0, { "open": thinkOpen })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button> `);
        {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { card });
  });
}
function CardAssistant($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let tools, text, m, hasMeta;
    let card = $$props["card"];
    let onRegenerate = fallback($$props["onRegenerate"], void 0);
    let onRevert = fallback($$props["onRevert"], void 0);
    let reverting = false;
    function fmtK(n) {
      return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
    }
    let copied = false;
    let copyTimer;
    onDestroy(() => clearTimeout(copyTimer));
    tools = card.blocks.filter((b) => b.type === "tool").map((b) => ({
      tool: b.tool,
      args: b.args,
      status: b.status,
      partId: b.partId,
      messageId: b.messageId
    }));
    text = card.blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    m = card.meta;
    hasMeta = m.agent || m.model || m.tokens || m.duration != null || m.cost !== void 0;
    $$renderer2.push(`<div class="card assistant svelte-wmi6xy">`);
    if (card.thinkingText) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<details class="think svelte-wmi6xy"><summary class="svelte-wmi6xy">思考过程</summary> <pre class="svelte-wmi6xy">${escape_html(card.thinkingText)}</pre></details>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    ToolCallList($$renderer2, { tools, sessionId: card.sessionId });
    $$renderer2.push(`<!----> `);
    if (text) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="text svelte-wmi6xy">`);
      MarkdownView($$renderer2, { src: text });
      $$renderer2.push(`<!----></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (hasMeta) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="meta svelte-wmi6xy"><div class="chips svelte-wmi6xy">`);
      if (m.agent) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="chip agent mono svelte-wmi6xy">${escape_html(m.agent)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (m.model) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="chip mono svelte-wmi6xy">${escape_html(m.model)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (m.tokens) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="chip mono svelte-wmi6xy" title="输入 / 输出 tokens">↑${escape_html(fmtK(m.tokens.input))} ↓${escape_html(fmtK(m.tokens.output))}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (m.duration != null) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="chip mono svelte-wmi6xy">${escape_html(m.duration)}s</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (m.cost !== void 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="chip cost mono svelte-wmi6xy" title="本次回复成本">$${escape_html(m.cost < 1e-3 ? "<$0.001" : m.cost.toFixed(3))}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div> <div class="actions svelte-wmi6xy">`);
      if (onRegenerate) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="icon svelte-wmi6xy" title="重新生成" aria-label="重新生成">`);
        Icon($$renderer2, { name: "refresh", size: 13 });
        $$renderer2.push(`<!----></button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (onRevert) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button${attr_class("icon svelte-wmi6xy", void 0, { "reverting": reverting })} title="撤销这一轮" aria-label="撤销这一轮"${attr("disabled", reverting, true)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-15-6.7L3 13"></path></svg></button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <button${attr_class("icon svelte-wmi6xy", void 0, { "copied": copied })} title="复制" aria-label="复制">`);
      {
        $$renderer2.push("<!--[-1-->");
        Icon($$renderer2, { name: "copy", size: 13 });
      }
      $$renderer2.push(`<!--]--></button></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { card, onRegenerate, onRevert });
  });
}
function CardError($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let kind;
    let card = $$props["card"];
    let onRetry = fallback($$props["onRetry"], void 0);
    createEventDispatcher();
    function classify(m) {
      const s = (m || "").toLowerCase();
      if (s.includes("abort")) return { label: "Stopped", retryable: false };
      if (s.includes("timeout") || s.includes("timed out")) return { label: "Timed out", retryable: true };
      if (s.includes("fetch") || s.includes("network") || s.includes("econn") || /\b(429|500|502|503|504)\b/.test(s)) return { label: "Network issue", retryable: true };
      return { label: "Error", retryable: true };
    }
    kind = classify(card.message);
    $$renderer2.push(`<div class="card error svelte-1m8kde8"><div class="head svelte-1m8kde8">`);
    Icon($$renderer2, { name: "alert", size: 13 });
    $$renderer2.push(`<!----> ${escape_html(kind.label)}</div> <code class="svelte-1m8kde8">${escape_html(card.message)}</code> `);
    if (kind.retryable) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="retry svelte-1m8kde8"${attr("disabled", !onRetry, true)}>`);
      Icon($$renderer2, { name: "refresh", size: 11 });
      $$renderer2.push(`<!----> Retry</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { card, onRetry });
  });
}
function CardInfo($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let body, text;
    let card = $$props["card"];
    body = card.sections.map((s) => s.body).join(" ") || "";
    text = [card.title, body].filter(Boolean).join(" — ");
    $$renderer2.push(`<div class="note mono svelte-hbf6ni">${escape_html(text)}</div>`);
    bind_props($$props, { card });
  });
}
function CardStatus($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let title, fields, extra, text;
    let card = $$props["card"];
    title = card.fields.title ?? "Status";
    fields = Object.entries(card.fields).filter(([k]) => k !== "title");
    extra = fields.map(([k, v]) => `${k}: ${v}`).join(" · ");
    text = [title, extra].filter(Boolean).join(" · ");
    $$renderer2.push(`<div class="note mono svelte-scaqco">${escape_html(text)}</div>`);
    bind_props($$props, { card });
  });
}
function CardApproval($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let resolved, isReject, diffText;
    let card = $$props["card"];
    let done = "";
    const LABEL = {
      once: "已批准 — 已应用",
      always: "已设为自动允许",
      reject: "已拒绝 — 未应用",
      error: "失败"
    };
    resolved = false;
    isReject = done === "error";
    diffText = typeof card.args === "string" ? card.args : JSON.stringify(card.args, null, 2);
    if (resolved) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div${attr_class("appr resolved svelte-19vkggv", void 0, { "rej": isReject })}><span class="mark svelte-19vkggv" aria-hidden="true">${escape_html(isReject ? "✕" : "✓")}</span> <span class="rlabel svelte-19vkggv">${escape_html(LABEL[done] ?? done)}</span> <span class="rttl svelte-19vkggv">${escape_html(card.title)}</span></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="appr pending svelte-19vkggv"><div class="header svelte-19vkggv"><span class="warn-dot svelte-19vkggv" aria-hidden="true"></span> <span class="label svelte-19vkggv">需要审批</span> <span class="rule svelte-19vkggv" aria-hidden="true"></span> <span class="tool mono svelte-19vkggv">${escape_html(card.title)}</span></div> <pre class="diff mono svelte-19vkggv">${escape_html(diffText)}</pre> <div class="acts svelte-19vkggv"><button class="a allow svelte-19vkggv">批准</button> <button class="a always svelte-19vkggv">总是允许</button> <span class="spacer svelte-19vkggv"></span> <button class="a rej svelte-19vkggv">拒绝</button></div></div>`);
    }
    $$renderer2.push(`<!--]-->`);
    bind_props($$props, { card });
  });
}
function CardQuestion($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let resolved, stale, answerable, complete;
    let card = $$props["card"];
    let sel = {};
    let custom = {};
    let done = "";
    const RESOLVED_LABEL = {
      replied: "已回答",
      rejected: "已取消",
      stale: "已在其他界面回答",
      error: "提交失败"
    };
    resolved = card.resolved ?? void 0;
    stale = done === "stale";
    answerable = store_get($$store_subs ??= {}, "$can", can)("questions");
    complete = (card.questions ?? []).every((q, qi) => {
      if ((custom[qi] ?? "").trim()) return true;
      return (sel[qi] ?? []).length > 0;
    });
    if (resolved || stale) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div${attr_class("qcard resolved svelte-hiqfhq", void 0, {
        "fresh": done !== "",
        "rej": resolved === "rejected" || stale || done === "error"
      })}><span class="mark svelte-hiqfhq" aria-hidden="true">${escape_html(resolved === "replied" ? "✓" : "✕")}</span> <span class="rlabel svelte-hiqfhq">${escape_html(RESOLVED_LABEL[resolved ?? done] ?? "")}</span> <span class="rttl mono svelte-hiqfhq">${escape_html(card.requestId.slice(0, 12))}</span></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="qcard pending svelte-hiqfhq"><div class="header svelte-hiqfhq"><span class="q-dot svelte-hiqfhq" aria-hidden="true"></span> <span class="label svelte-hiqfhq">需要你的回答</span> <span class="rule svelte-hiqfhq" aria-hidden="true"></span> `);
      if (!answerable) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="mono warn-note svelte-hiqfhq">当前后端不支持 Web 回答</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div> <!--[-->`);
      const each_array = ensure_array_like(card.questions);
      for (let qi = 0, $$length = each_array.length; qi < $$length; qi++) {
        let q = each_array[qi];
        $$renderer2.push(`<div class="q svelte-hiqfhq">`);
        if (q.header) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="qhead mono svelte-hiqfhq">${escape_html(q.header)}</div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="qtext svelte-hiqfhq">${escape_html(q.question)}</div> <div class="opts svelte-hiqfhq"><!--[-->`);
        const each_array_1 = ensure_array_like(q.options);
        for (let oi = 0, $$length2 = each_array_1.length; oi < $$length2; oi++) {
          let opt = each_array_1[oi];
          $$renderer2.push(`<button${attr_class("opt svelte-hiqfhq", void 0, { "on": (sel[qi] ?? []).includes(oi) })}${attr("title", opt.description ?? opt.label)}>${escape_html(opt.label)}</button>`);
        }
        $$renderer2.push(`<!--]--></div> `);
        if (q.custom) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<input class="custom mono svelte-hiqfhq" placeholder="或输入自定义回答…"${attr("value", custom[qi] ?? "")}/>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (q.multiple) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="hint svelte-hiqfhq">可多选</div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div>`);
      }
      $$renderer2.push(`<!--]--> <div class="acts svelte-hiqfhq"><button class="a send svelte-hiqfhq"${attr("disabled", !answerable || !complete || done === "error", true)}>提交回答</button> <span class="spacer svelte-hiqfhq"></span> <button class="a rej svelte-hiqfhq"${attr("disabled", !answerable, true)}>取消</button></div></div>`);
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { card });
  });
}
function Card($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let card = $$props["card"];
    let onRetry = fallback($$props["onRetry"], void 0);
    let onRegenerate = fallback($$props["onRegenerate"], void 0);
    let onRevert = fallback($$props["onRevert"], void 0);
    if (card.kind === "user") {
      $$renderer2.push("<!--[0-->");
      CardUser($$renderer2, { card });
    } else if (card.kind === "thinking") {
      $$renderer2.push("<!--[1-->");
      CardThinking($$renderer2, { card });
    } else if (card.kind === "streaming") {
      $$renderer2.push("<!--[2-->");
      CardStreaming($$renderer2, { card });
    } else if (card.kind === "assistant") {
      $$renderer2.push("<!--[3-->");
      CardAssistant($$renderer2, { card, onRegenerate, onRevert });
    } else if (card.kind === "error") {
      $$renderer2.push("<!--[4-->");
      CardError($$renderer2, { card, onRetry });
    } else if (card.kind === "info") {
      $$renderer2.push("<!--[5-->");
      CardInfo($$renderer2, { card });
    } else if (card.kind === "status") {
      $$renderer2.push("<!--[6-->");
      CardStatus($$renderer2, { card });
    } else if (card.kind === "approval") {
      $$renderer2.push("<!--[7-->");
      CardApproval($$renderer2, { card });
    } else if (card.kind === "question") {
      $$renderer2.push("<!--[8-->");
      CardQuestion($$renderer2, { card });
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="card placeholder svelte-1udyrqm">[${escape_html(card.kind)}]</div>`);
    }
    $$renderer2.push(`<!--]-->`);
    bind_props($$props, { card, onRetry, onRegenerate, onRevert });
  });
}
function mapStatus(s) {
  const v = String(s ?? "").toLowerCase();
  if (v === "completed" || v === "done") return "done";
  if (v === "in_progress" || v === "running" || v === "active") return "running";
  return "pending";
}
function summarizeTodos(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const items = list.map((t) => ({
    text: String(t?.content ?? t?.text ?? t?.title ?? ""),
    status: mapStatus(t?.status)
  }));
  return { total: items.length, done: items.filter((i) => i.status === "done").length, items };
}
export {
  Card as C,
  HOMES as H,
  Icon as I,
  MarkdownView as M,
  composerDraft as a,
  composerEmpty as b,
  channelsOpen as c,
  connection as d,
  leftPanelOpen as e,
  feedResyncing as f,
  plusMenuOpen as g,
  html as h,
  inspectorOpen as i,
  sessionBooting as j,
  sidePane as k,
  latency as l,
  summarizeTodos as m,
  newSessionOpen as n,
  themeMode as o,
  page as p,
  saveComposerDraft as s,
  takeComposerDraft as t
};
