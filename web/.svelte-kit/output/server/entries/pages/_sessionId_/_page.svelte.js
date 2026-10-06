import { f as ensure_array_like, c as attr_style, d as bind_props, a as attr, h as stringify, g as store_get, u as unsubscribe_stores, b as attr_class } from "../../../chunks/index.js";
import { I as Icon, s as saveComposerDraft, t as takeComposerDraft, a as composerDraft, b as composerEmpty, d as connection, m as summarizeTodos, i as inspectorOpen, C as Card, p as page, j as sessionBooting, e as leftPanelOpen, f as feedResyncing } from "../../../chunks/summarizeTodos.js";
import { g as goto } from "../../../chunks/client.js";
import { e as escape_html, b as onMount, o as onDestroy, t as tick } from "../../../chunks/index-client.js";
import { e as api, l as cardsOf, n as feeds, i as backendName, k as can, d as agentAccent, j as backends, w as sessionList, A as ACCENT_BG, a as ACCENT_HEX, b as ACCENT_LINE, v as serverBusy } from "../../../chunks/capabilities.js";
import { N as fallback } from "../../../chunks/environment.js";
import "@sveltejs/kit/internal";
import "../../../chunks/exports.js";
import "../../../chunks/shared.js";
function Suggestions($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let suggestions = fallback($$props["suggestions"], () => [], true);
    let onPick = fallback($$props["onPick"], () => {
    });
    let onDismiss = fallback($$props["onDismiss"], () => {
    });
    if (suggestions.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="suggestions svelte-1hbn5f9" role="list" aria-label="建议的后续操作"><!--[-->`);
      const each_array = ensure_array_like(suggestions);
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let s = each_array[i];
        $$renderer2.push(`<span role="listitem"><button class="chip svelte-1hbn5f9"${attr_style(`animation-delay: ${Math.min(i, 5) * 45}ms`)}>${escape_html(s)}</button></span>`);
      }
      $$renderer2.push(`<!--]--> <button class="dismiss svelte-1hbn5f9" aria-label="忽略建议">`);
      Icon($$renderer2, { name: "close", size: 12 });
      $$renderer2.push(`<!----></button></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    bind_props($$props, { suggestions, onPick, onDismiss });
  });
}
function AgentChip($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let label;
    let open = false;
    let agents = [];
    let current = { agent: null, model: null };
    async function refresh() {
      try {
        [agents, current] = await Promise.all([api.agents(), api.getOverrides()]);
      } catch {
      }
    }
    onMount(refresh);
    label = current.agent ?? "default";
    $$renderer2.push(`<div class="wrap svelte-1f5vmb3"><button class="chip mono svelte-1f5vmb3" aria-haspopup="listbox"${attr("aria-expanded", open)}>`);
    Icon($$renderer2, { name: "cpu", size: 11 });
    $$renderer2.push(`<!----> <span class="txt svelte-1f5vmb3">${escape_html(label)}</span> `);
    Icon($$renderer2, { name: "caret-down", size: 9 });
    $$renderer2.push(`<!----></button> <button class="chip icon mono svelte-1f5vmb3" aria-haspopup="listbox"${attr("aria-label", `Agent：${label}`)}${attr("aria-expanded", open)}>`);
    Icon($$renderer2, { name: "cpu", size: 14 });
    $$renderer2.push(`<!----></button> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function ModelChip($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let label;
    let open = false;
    let providers = [];
    let current = { agent: null, model: null };
    async function refresh() {
      try {
        [providers, current] = await Promise.all([api.models(), api.getOverrides()]);
      } catch {
      }
    }
    onMount(refresh);
    label = current.model?.modelID ?? "model";
    $$renderer2.push(`<div class="wrap svelte-1005b73"><button class="chip mono svelte-1005b73" aria-haspopup="listbox"${attr("aria-expanded", open)}>`);
    Icon($$renderer2, { name: "bolt", size: 11 });
    $$renderer2.push(`<!----> <span class="txt svelte-1005b73">${escape_html(label)}</span> `);
    Icon($$renderer2, { name: "caret-down", size: 9 });
    $$renderer2.push(`<!----></button> <button class="chip icon mono svelte-1005b73" aria-haspopup="listbox"${attr("aria-label", `模型：${label}`)}${attr("aria-expanded", open)}>`);
    Icon($$renderer2, { name: "bolt", size: 14 });
    $$renderer2.push(`<!----></button> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function EffortChip($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let label;
    let open = false;
    let providers = [];
    let current = { agent: null, model: null };
    async function refresh() {
      try {
        [providers, current] = await Promise.all([api.models(), api.getOverrides()]);
      } catch {
      }
    }
    onMount(refresh);
    (() => {
      const modelID = current.model?.modelID;
      for (const p of providers) {
        const hit = (p.models ?? []).find((m) => m.id === modelID);
        if (hit?.variants?.length) return hit.variants;
      }
      return [];
    })();
    label = current.variant || "默认";
    $$renderer2.push(`<div class="wrap svelte-9uesc0"><button class="chip mono svelte-9uesc0" aria-haspopup="listbox"${attr("aria-expanded", open)}${attr("title", `推理强度（当前模型：${stringify(current.model?.modelID ?? "—")}）`)}>`);
    Icon($$renderer2, { name: "brain", size: 11 });
    $$renderer2.push(`<!----> <span class="txt svelte-9uesc0">${escape_html(label)}</span> `);
    Icon($$renderer2, { name: "caret-down", size: 9 });
    $$renderer2.push(`<!----></button> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function SessionControls($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let modeOpts, modelOpts, modeLabel, modelLabel;
    let sessionId = $$props["sessionId"];
    let controls = {};
    let openPanel = null;
    async function load() {
      const sid = sessionId;
      try {
        const res = await api.controls(sid);
        if (sid !== sessionId) return;
        controls = res;
      } catch {
        if (sid === sessionId) controls = {};
      }
    }
    if (sessionId) load();
    modeOpts = controls.mode?.options ?? [];
    modelOpts = controls.model?.options ?? [];
    modeLabel = controls.mode?.options.find((o) => o.id === controls.mode?.current)?.name ?? controls.mode?.current ?? "mode";
    modelLabel = controls.model?.options.find((o) => o.id === controls.model?.current)?.name ?? controls.model?.current ?? "model";
    $$renderer2.push(`<div class="controls svelte-dkbq22">`);
    if (modeOpts.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="wrap svelte-dkbq22"><button class="chip mono svelte-dkbq22" aria-haspopup="listbox"${attr("aria-expanded", openPanel === "mode")}>`);
      Icon($$renderer2, { name: "bolt", size: 11 });
      $$renderer2.push(`<!----> <span class="txt svelte-dkbq22">${escape_html(modeLabel)}</span> `);
      Icon($$renderer2, { name: "caret-down", size: 9 });
      $$renderer2.push(`<!----></button> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (modelOpts.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="wrap svelte-dkbq22"><button class="chip mono svelte-dkbq22" aria-haspopup="listbox"${attr("aria-expanded", openPanel === "model")}>`);
      Icon($$renderer2, { name: "cpu", size: 11 });
      $$renderer2.push(`<!----> <span class="txt svelte-dkbq22">${escape_html(modelLabel)}</span> `);
      Icon($$renderer2, { name: "caret-down", size: 9 });
      $$renderer2.push(`<!----></button> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { sessionId });
  });
}
function ContextRing($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let seq, tin, tout, used, max, maxUnknown, pct, arcColor, feed;
    let sessionId = $$props["sessionId"];
    let ctx = {};
    let open = false;
    let closeTimer;
    let loadedFor;
    let lastSeqSeen = -1;
    let timer;
    async function load(sid) {
      try {
        ctx = await api.context(sid);
      } catch {
      }
    }
    function onVis() {
      if (!document.hidden) void load(sessionId);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    onDestroy(() => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    });
    const R = 10;
    const CIRC = 2 * Math.PI * R;
    function fmtK(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(n);
    }
    if (sessionId !== loadedFor) {
      loadedFor = sessionId;
      void load(sessionId);
    }
    seq = store_get($$store_subs ??= {}, "$feeds", feeds)[sessionId]?.lastSeq ?? 0;
    if (seq !== lastSeqSeen) {
      lastSeqSeen = seq;
      clearTimeout(timer);
      if (typeof document === "undefined" || !document.hidden) {
        timer = setTimeout(() => void load(sessionId), 1e3);
      }
    }
    tin = typeof ctx?.tokens?.input === "number" ? ctx.tokens.input : 0;
    tout = typeof ctx?.tokens?.output === "number" ? ctx.tokens.output : 0;
    used = typeof ctx?.tokens?.used === "number" ? ctx.tokens.used : tin + tout;
    max = typeof ctx?.tokens?.max === "number" ? ctx.tokens.max : void 0;
    maxUnknown = !max;
    pct = used > 0 && max ? Math.min(100, used / max * 100) : 0;
    arcColor = pct >= 90 ? "var(--err)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
    ctx?.model ? String(ctx.model).split("/").pop() : void 0;
    typeof ctx?.cost === "number" ? ctx.cost : void 0;
    typeof ctx?.tokens?.cache?.read === "number" ? ctx.tokens.cache.read : 0;
    typeof ctx?.tokens?.cache?.write === "number" ? ctx.tokens.cache.write : 0;
    feed = store_get($$store_subs ??= {}, "$feeds", feeds)[sessionId];
    cardsOf(feed).filter((c) => c.kind === "user" || c.kind === "assistant").length;
    $$renderer2.push(`<div class="wrap svelte-4bdpxt" role="presentation"><button class="ring svelte-4bdpxt"${attr("aria-label", maxUnknown ? `上下文用量 ${fmtK(used)}（上限未知）` : `上下文占用 ${pct.toFixed(0)}%`)}${attr("aria-expanded", open)}${attr("title", maxUnknown ? `上下文用量 ${fmtK(used)}` : `上下文 ${fmtK(used)} / ${fmtK(max ?? 0)}`)}><svg viewBox="0 0 24 24" aria-hidden="true" class="svelte-4bdpxt"><circle class="track svelte-4bdpxt" cx="12" cy="12"${attr("r", R)}></circle><circle class="arc svelte-4bdpxt" cx="12" cy="12"${attr("r", R)}${attr("stroke", arcColor)}${attr("stroke-dasharray", `${Math.max(CIRC * pct / 100, pct > 0 ? 1.5 : 0)} ${CIRC}`)} transform="rotate(-90 12 12)"></circle></svg> <span class="pct mono svelte-4bdpxt">${escape_html(maxUnknown ? used > 0 ? fmtK(used) : "—" : `${pct.toFixed(0)}%`)}</span></button> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { sessionId });
  });
}
function Composer($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let hasText, busy, showStop;
    let sessionId = $$props["sessionId"];
    let text = "";
    let textarea;
    let draftSid;
    let focused = false;
    let pendingImages = [];
    let mentionResults = [];
    let mentionActive = 0;
    let mentionTimer;
    onDestroy(() => clearTimeout(mentionTimer));
    if (sessionId !== draftSid) {
      if (draftSid !== void 0) saveComposerDraft(draftSid, text);
      draftSid = sessionId;
      text = takeComposerDraft(sessionId);
    }
    {
      const d = store_get($$store_subs ??= {}, "$composerDraft", composerDraft);
      if (d) {
        text = d.text;
        composerDraft.set(void 0);
        tick().then(() => textarea?.focus());
      }
    }
    if (text !== void 0) saveComposerDraft(sessionId, text);
    composerEmpty.set(!text.trim());
    hasText = text.trim().length > 0;
    busy = (() => {
      const feed = store_get($$store_subs ??= {}, "$feeds", feeds)[sessionId];
      if (!feed || feed.order.length === 0) return false;
      const last = feed.byId[feed.order[feed.order.length - 1]];
      return last?.kind === "thinking" || last?.kind === "streaming" || last?.kind === "think-stream";
    })();
    showStop = busy && !hasText && true;
    $$renderer2.push(`<div class="composer svelte-60fagq"><div class="dock svelte-60fagq">`);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div${attr_class("box svelte-60fagq", void 0, { "focused": focused, "has-text": hasText })}>`);
    if (mentionResults.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="mention-dropdown svelte-60fagq" role="listbox"><!--[-->`);
      const each_array = ensure_array_like(mentionResults);
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let path = each_array[i];
        $$renderer2.push(`<button${attr_class("mention-row svelte-60fagq", void 0, { "active": i === mentionActive })} role="option"${attr("aria-selected", i === mentionActive)}>${escape_html(path)}</button>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (pendingImages.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="thumbnails svelte-60fagq"><!--[-->`);
      const each_array_1 = ensure_array_like(pendingImages);
      for (let i = 0, $$length = each_array_1.length; i < $$length; i++) {
        let img = each_array_1[i];
        $$renderer2.push(`<div class="thumb svelte-60fagq"><img${attr("src", img.preview)} alt="attachment" class="svelte-60fagq"/> <button class="remove svelte-60fagq" aria-label="移除图片">×</button></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <textarea${attr("placeholder", store_get($$store_subs ??= {}, "$connection", connection) === "connected" ? `给 ${store_get($$store_subs ??= {}, "$backendName", backendName)} 留言…` : "连接断开…")} aria-label="消息输入"${attr("rows", 1)} class="svelte-60fagq">`);
    const $$body = escape_html(text);
    if ($$body) {
      $$renderer2.push(`${$$body}`);
    }
    $$renderer2.push(`</textarea> <div class="footer svelte-60fagq">`);
    if (store_get($$store_subs ??= {}, "$can", can)("imageInput")) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="attach svelte-60fagq" aria-label="附加图片"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></button> <input type="file" accept="image/*" multiple="" style="display:none"/>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (store_get($$store_subs ??= {}, "$can", can)("catalog")) {
      $$renderer2.push("<!--[0-->");
      AgentChip($$renderer2);
      $$renderer2.push(`<!----> `);
      ModelChip($$renderer2);
      $$renderer2.push(`<!----> `);
      EffortChip($$renderer2);
      $$renderer2.push(`<!---->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (store_get($$store_subs ??= {}, "$can", can)("sessionControls")) {
      $$renderer2.push("<!--[0-->");
      SessionControls($$renderer2, { sessionId });
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    ContextRing($$renderer2, { sessionId });
    $$renderer2.push(`<!----> <button class="hint command svelte-60fagq">「/」命令</button> <span class="spacer svelte-60fagq"></span> <span class="hint send-hint svelte-60fagq">↵ 发送 · ⇧↵ 换行</span> `);
    if (showStop) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="send stop svelte-60fagq" aria-label="停止" title="停止生成"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg></button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<button class="send svelte-60fagq" aria-label="发送"${attr("disabled", !text.trim() && pendingImages.length === 0 || store_get($$store_subs ??= {}, "$connection", connection) !== "connected", true)}>`);
      {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>`);
      }
      $$renderer2.push(`<!--]--></button>`);
    }
    $$renderer2.push(`<!--]--></div></div></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { sessionId });
  });
}
function SessionSwitcher($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let activeBackendId, activeAgent, theme, activeSession, title;
    let activeId = fallback($$props["activeId"], void 0);
    let interactive = fallback($$props["interactive"], true);
    let open = false;
    function glyphFrom(text) {
      const words = text.split(/[\s\-_:./]+/).filter(Boolean);
      if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
      return text.slice(0, 2).toUpperCase();
    }
    function glyph(agent) {
      return glyphFrom(agent?.name || agent?.id || "OC");
    }
    function statusClass(status) {
      if (status === "online" || status === "connected") return "online";
      if (status === "connecting" || status === "reconnecting") return "connecting";
      if (status === "offline") return "offline";
      return "online";
    }
    activeBackendId = store_get($$store_subs ??= {}, "$backends", backends)?.activeId ?? store_get($$store_subs ??= {}, "$backends", backends)?.backends[0]?.id ?? "opencode";
    activeAgent = store_get($$store_subs ??= {}, "$backends", backends)?.backends.find((b) => b.id === activeBackendId);
    theme = agentAccent(activeBackendId);
    store_get($$store_subs ??= {}, "$sessionList", sessionList).filter((s) => s.backendId === activeBackendId || !s.backendId && activeBackendId === "opencode").sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    activeSession = store_get($$store_subs ??= {}, "$sessionList", sessionList).find((s) => s.id === activeId);
    title = activeSession?.title || "Untitled session";
    $$renderer2.push(`<div class="switcher svelte-rgafhj"><button${attr_class("trigger svelte-rgafhj", void 0, { "plain": !interactive })}${attr("aria-haspopup", interactive ? "true" : void 0)}${attr("aria-expanded", interactive ? open : void 0)}${attr("title", interactive ? "Switch session" : title)}><span class="glyph-tile svelte-rgafhj"${attr_style(`background:${stringify(ACCENT_BG[theme])}; color:${stringify(ACCENT_HEX[theme])}; border-color:${stringify(ACCENT_LINE[theme])}`)}>${escape_html(glyph(activeAgent))}</span> <span${attr_class(`status-dot ${stringify(statusClass(activeAgent?.status))}`, "svelte-rgafhj")}><span class="sr-only svelte-rgafhj">${escape_html(statusClass(activeAgent?.status))}</span></span> <span class="title svelte-rgafhj">${escape_html(title)}</span> `);
    if (interactive) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="caret svelte-rgafhj" aria-hidden="true">`);
      Icon($$renderer2, { name: "caret-down", size: 11 });
      $$renderer2.push(`<!----></span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></button> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { activeId, interactive });
  });
}
function PlanHud($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let seq, session, title, doneItems, runningItems, pendingItems, restCount, pct, dismissed, runningSubs, idleSubs;
    let sessionId = $$props["sessionId"];
    let onJump = fallback($$props["onJump"], () => {
    });
    const KEY_BASE = "ocrc.planHud.v3";
    const INLINE_PENDING = 5;
    const R = 16;
    const CIRC = 2 * Math.PI * R;
    let desktop = false;
    try {
      desktop = window.matchMedia("(min-width: 821px)").matches;
    } catch {
    }
    const KEY = desktop ? "ocrc.planHud.dt3" : KEY_BASE;
    function loadState() {
      if (typeof localStorage === "undefined") return {};
      try {
        const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
        return { dismissed: s.dismissed, expanded: s.expanded };
      } catch {
        return {};
      }
    }
    let hud = loadState();
    let expanded = hud.expanded ?? desktop;
    function save(next) {
      hud = { ...hud, ...next };
      if (typeof localStorage === "undefined") return;
      try {
        localStorage.setItem(KEY, JSON.stringify(hud));
      } catch {
      }
    }
    let sum = { total: 0, done: 0, items: [] };
    let loadedFor;
    async function refresh(sid) {
      try {
        const todos = await api.todo(sid);
        if (sid !== sessionId) return;
        loadedFor = sid;
        sum = summarizeTodos(todos);
      } catch {
      }
    }
    let loadedSid;
    let tick2 = 0;
    let lastSeqSeen = -1;
    let timer;
    onDestroy(() => clearTimeout(timer));
    let subs = [];
    let subsFor;
    let subsBusy = false;
    async function refreshSubs(sid) {
      if (subsBusy) return;
      subsBusy = true;
      try {
        const r = await api.subagents(sid);
        if (sid !== sessionId) return;
        subs = [...r.subagents ?? []].sort((a, b) => Number(b.busy ?? false) - Number(a.busy ?? false));
        subsFor = sid;
      } catch {
        subs = [];
      } finally {
        subsBusy = false;
      }
    }
    const SUB_PARENT_KEY = (id) => `ocrc.subparent.${id}`;
    let breadcrumb;
    function readBreadcrumb(sid) {
      try {
        breadcrumb = sessionStorage.getItem(SUB_PARENT_KEY(sid)) ?? void 0;
      } catch {
        breadcrumb = void 0;
      }
    }
    readBreadcrumb(sessionId);
    let groupSid;
    let showDone = false;
    let showRest = false;
    let showIdle = false;
    let menuOpen = false;
    let autoExpanded = false;
    let pollTimer;
    async function autoExpandTick() {
      const sid = sessionId;
      if (!desktop || expanded || dismissed) return;
      let busy = false;
      try {
        const r = await api.subagents(sid);
        if (sid !== sessionId) return;
        subs = [...r.subagents ?? []].sort((a, b) => Number(b.busy ?? false) - Number(a.busy ?? false));
        busy = (r.subagents ?? []).some((s) => s.busy);
      } catch {
        return;
      }
      if (sid !== sessionId) return;
      if (!busy) {
        autoExpanded = false;
        return;
      }
      if (autoExpanded) return;
      if (store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen) || !store_get($$store_subs ??= {}, "$composerEmpty", composerEmpty)) return;
      if (typeof document === "undefined" || document.hidden) return;
      if (sum.total === 0 || sum.done >= sum.total) return;
      expanded = true;
      autoExpanded = true;
      save({ expanded: true });
    }
    onDestroy(() => {
      clearInterval(pollTimer);
    });
    if (sessionId !== loadedSid) {
      loadedSid = sessionId;
      void refresh(sessionId);
    }
    seq = store_get($$store_subs ??= {}, "$feeds", feeds)[sessionId]?.lastSeq ?? 0;
    if (seq !== lastSeqSeen) {
      lastSeqSeen = seq;
      clearTimeout(timer);
      timer = setTimeout(() => tick2 += 1, 1e3);
    }
    if (tick2 && (typeof document === "undefined" || !document.hidden)) {
      void refresh(sessionId);
      void refreshSubs(sessionId);
    }
    session = store_get($$store_subs ??= {}, "$sessionList", sessionList).find((r) => r.id === sessionId);
    title = session?.title ?? "";
    doneItems = sum.items.filter((i) => i.status === "done");
    runningItems = sum.items.filter((i) => i.status === "running");
    pendingItems = sum.items.filter((i) => i.status === "pending");
    restCount = Math.max(0, pendingItems.length - INLINE_PENDING);
    pct = sum.total ? sum.done / sum.total : 0;
    dismissed = hud.dismissed?.includes(sessionId) ?? false;
    runningSubs = subs.filter((s) => s.busy);
    idleSubs = subs.filter((s) => !s.busy);
    if (autoExpanded && expanded && subs.length > 0 && runningSubs.length === 0) {
      autoExpanded = false;
      expanded = false;
      save({ expanded: false });
    }
    if (expanded && sessionId && subsFor !== sessionId) void refreshSubs(sessionId);
    if (sessionId) readBreadcrumb(sessionId);
    if (sessionId !== groupSid) {
      groupSid = sessionId;
      showDone = false;
      showRest = false;
      showIdle = false;
      menuOpen = false;
    }
    if (typeof window !== "undefined") {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => void autoExpandTick(), 3e3);
    }
    if (
      // ZCode register (SessionPane sections): a section folds itself when its
      // work count drops to 0. We only auto-close what WE auto-opened — a
      // manually opened card stays until the user closes it.
      // Auto-collapse: a tap anywhere outside the card and the orb closes the
      // card — one overlay at a time (opening a chip popover therefore collapses
      // the plan card, and vice versa via the chips' own outside-close).
      // 点外收起是移动端遮罩层（scrim）的交互；桌面 dock 窗口只经 ✕ 收起——
      // 否则用户一边看结果一边点页面，展开就被自己的点击收掉（0.26.22 事故）。
      loadedFor === sessionId && (sum.total > 0 || subs.length > 0 || breadcrumb) && store_get($$store_subs ??= {}, "$can", can)("todos")
    ) {
      $$renderer2.push("<!--[0-->");
      if (dismissed && !desktop) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="ghost svelte-w3h0m4" title="重新显示计划窗"><span class="label svelte-w3h0m4">计划</span> <span class="bar-count mono svelte-w3h0m4">${escape_html(sum.done)}<i class="svelte-w3h0m4">/</i>${escape_html(sum.total)}</span></button>`);
      } else if (expanded) {
        $$renderer2.push("<!--[1-->");
        if (!desktop) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="scrim svelte-w3h0m4" aria-hidden="true"></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="plan-card svelte-w3h0m4"><div class="hd svelte-w3h0m4"><span class="label svelte-w3h0m4">计划</span> <span class="title svelte-w3h0m4">${escape_html(title || "…" + sessionId.slice(-8))}</span> <button class="dots svelte-w3h0m4" aria-label="Plan menu">⋯</button> <button class="close svelte-w3h0m4" aria-label="收起计划"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svelte-w3h0m4"><path d="M18 15l-6-6-6 6"></path></svg></button></div> `);
        if (menuOpen) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="menu svelte-w3h0m4" role="menu"><button role="menuitem" class="svelte-w3h0m4">打开任务面板</button> `);
          if (!desktop) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<button role="menuitem" class="svelte-w3h0m4">本会话隐藏</button>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="body svelte-w3h0m4">`);
        if (breadcrumb) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<button class="crumb svelte-w3h0m4"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svelte-w3h0m4"><path d="M15 18l-6-6 6-6"></path></svg> <span>返回父会话 …${escape_html(breadcrumb.slice(-8))}</span></button>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="prog mono svelte-w3h0m4">任务 ${escape_html(sum.done)}/${escape_html(sum.total)}</div> `);
        if (doneItems.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<button class="grp svelte-w3h0m4"${attr("aria-expanded", showDone)}><svg${attr_class("caret svelte-w3h0m4", void 0, { "open": showDone })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg> <span>已完成 ${escape_html(doneItems.length)}</span></button> `);
          if (showDone) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<!--[-->`);
            const each_array = ensure_array_like(doneItems);
            for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
              let it = each_array[$$index];
              $$renderer2.push(`<div class="row done svelte-w3h0m4"><span class="box svelte-w3h0m4"><span class="check svelte-w3h0m4">✓</span></span><span class="tx svelte-w3h0m4">${escape_html(it.text)}</span></div>`);
            }
            $$renderer2.push(`<!--]-->`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <!--[-->`);
        const each_array_1 = ensure_array_like(runningItems);
        for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
          let it = each_array_1[$$index_1];
          $$renderer2.push(`<div class="row running svelte-w3h0m4"><span class="box svelte-w3h0m4"><span class="dot svelte-w3h0m4"></span></span><span class="tx svelte-w3h0m4">${escape_html(it.text)}</span></div>`);
        }
        $$renderer2.push(`<!--]--> <!--[-->`);
        const each_array_2 = ensure_array_like(pendingItems.slice(0, INLINE_PENDING));
        for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
          let it = each_array_2[$$index_2];
          $$renderer2.push(`<div class="row pending svelte-w3h0m4"><span class="box svelte-w3h0m4"></span><span class="tx svelte-w3h0m4">${escape_html(it.text)}</span></div>`);
        }
        $$renderer2.push(`<!--]--> `);
        if (restCount > 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<button class="grp svelte-w3h0m4"${attr("aria-expanded", showRest)}><svg${attr_class("caret svelte-w3h0m4", void 0, { "open": showRest })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg> <span>待处理 ${escape_html(restCount)}</span></button> `);
          if (showRest) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<!--[-->`);
            const each_array_3 = ensure_array_like(pendingItems.slice(INLINE_PENDING));
            for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
              let it = each_array_3[$$index_3];
              $$renderer2.push(`<div class="row pending svelte-w3h0m4"><span class="box svelte-w3h0m4"></span><span class="tx svelte-w3h0m4">${escape_html(it.text)}</span></div>`);
            }
            $$renderer2.push(`<!--]-->`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (runningSubs.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="grp static svelte-w3h0m4"><span class="sub-label svelte-w3h0m4">子代理 · 运行中 ${escape_html(runningSubs.length)}</span></div> <!--[-->`);
          const each_array_4 = ensure_array_like(runningSubs);
          for (let $$index_4 = 0, $$length = each_array_4.length; $$index_4 < $$length; $$index_4++) {
            let s = each_array_4[$$index_4];
            $$renderer2.push(`<button class="row sub jump svelte-w3h0m4" title="打开子代理会话"><span class="sub-dot svelte-w3h0m4" aria-hidden="true"></span> `);
            if (s.total > 0) {
              $$renderer2.push("<!--[0-->");
              $$renderer2.push(`<span class="sub-count mono svelte-w3h0m4">${escape_html(s.done)}/${escape_html(s.total)}</span>`);
            } else {
              $$renderer2.push("<!--[-1-->");
            }
            $$renderer2.push(`<!--]--> <span class="tx svelte-w3h0m4">${escape_html(s.title || "…" + s.id.slice(-6))}</span> <svg class="go svelte-w3h0m4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>`);
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (idleSubs.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<button class="grp svelte-w3h0m4"${attr("aria-expanded", showIdle)}><svg${attr_class("caret svelte-w3h0m4", void 0, { "open": showIdle })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg> <span>子代理 · 已结束 ${escape_html(idleSubs.length)}</span></button> `);
          if (showIdle) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<!--[-->`);
            const each_array_5 = ensure_array_like(idleSubs);
            for (let $$index_5 = 0, $$length = each_array_5.length; $$index_5 < $$length; $$index_5++) {
              let s = each_array_5[$$index_5];
              $$renderer2.push(`<button class="row sub jump idle svelte-w3h0m4" title="打开子代理会话">`);
              if (s.total > 0 && s.done >= s.total) {
                $$renderer2.push("<!--[0-->");
                $$renderer2.push(`<span class="sub-check svelte-w3h0m4" aria-hidden="true">✓</span>`);
              } else {
                $$renderer2.push("<!--[-1-->");
              }
              $$renderer2.push(`<!--]--> `);
              if (s.total > 0) {
                $$renderer2.push("<!--[0-->");
                $$renderer2.push(`<span class="sub-count mono svelte-w3h0m4">${escape_html(s.done)}/${escape_html(s.total)}</span>`);
              } else {
                $$renderer2.push("<!--[-1-->");
              }
              $$renderer2.push(`<!--]--> <span class="tx svelte-w3h0m4">${escape_html(s.title || "…" + s.id.slice(-6))}</span> <svg class="go svelte-w3h0m4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>`);
            }
            $$renderer2.push(`<!--]-->`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (desktop && !expanded) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="bar svelte-w3h0m4"${attr("aria-label", `展开计划 ${sum.done}/${sum.total}`)}><span class="label svelte-w3h0m4">计划</span> <span class="bar-count mono svelte-w3h0m4">${escape_html(sum.done)}<i class="svelte-w3h0m4">/</i>${escape_html(sum.total)}</span> `);
        if (runningSubs.length > 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="badge mono svelte-w3h0m4">${escape_html(runningSubs.length)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <svg class="caret svelte-w3h0m4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"></path></svg></button>`);
      } else if (!dismissed && !(desktop && !expanded)) {
        $$renderer2.push("<!--[1-->");
        $$renderer2.push(`<button class="ball svelte-w3h0m4"${attr("aria-label", `计划 ${sum.done}/${sum.total} — ${expanded ? "收起" : "展开"}`)}${attr("aria-expanded", expanded)}><svg class="ring svelte-w3h0m4" viewBox="0 0 38 38" aria-hidden="true"><circle class="track svelte-w3h0m4" cx="19" cy="19"${attr("r", R)}></circle><circle class="arc svelte-w3h0m4" cx="19" cy="19"${attr("r", R)}${attr("stroke-dasharray", `${Math.max(CIRC * pct, CIRC * 0.02)} ${CIRC}`)} transform="rotate(-90 19 19)"></circle></svg> <span class="ball-count mono svelte-w3h0m4">${escape_html(sum.done)}<i class="svelte-w3h0m4">/</i>${escape_html(sum.total)}</span> `);
        if (runningSubs.length > 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="badge mono svelte-w3h0m4">${escape_html(runningSubs.length)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { sessionId, onJump });
  });
}
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let sessionId, feed, busy, cards, revertedCards, shownCards, session, branch, lastCard, scrollKey;
    let scrollEl;
    let isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
    const scrollCleanups = [];
    let io;
    let lastSeen = "";
    let ro;
    let vvCleanup;
    let runStart = 0;
    let runElapsed = 0;
    let runTimer;
    let pinnedToBottom = true;
    function pinBottom() {
    }
    const FIRST_WINDOW = 24;
    let visibleCount = FIRST_WINDOW;
    let hasMoreOlder = true;
    let loadingOlder = false;
    let windowForSid = "";
    let runSession = "";
    function fmtRunTime(s) {
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      const r = s % 60;
      return r === 0 ? `${m}m` : `${m}m ${r}s`;
    }
    function regenerateLast() {
      retryLast();
    }
    async function revertLast(messageId) {
      if (!sessionId || !messageId) return;
      try {
        await api.revertSession(sessionId, messageId);
        const { cards: cards2, lastSeq } = await api.history(sessionId);
        const { setHistory } = await import("../../../chunks/capabilities.js").then((n) => n.x);
        setHistory(sessionId, cards2, lastSeq);
        window.dispatchEvent(new CustomEvent("ocrc:resubscribe", { detail: { sessionId, sinceSeq: lastSeq } }));
      } catch {
      }
    }
    let reverted = false;
    let revertCutoff;
    async function checkReverted(sid) {
      try {
        const st = await api.revertState(sid);
        reverted = st.reverted;
        revertCutoff = st.messageID;
      } catch {
        reverted = false;
        revertCutoff = void 0;
      }
    }
    const STARTERS = ["总结这个项目", "最近有什么改动？", "运行检查"];
    let chipsDismissed = false;
    let tier2 = [];
    let fetchedFor;
    async function fetchSuggestions(sid, cid) {
      if (fetchedFor === cid) return;
      fetchedFor = cid;
      try {
        const r = await api.suggestions(sid);
        tier2 = r.suggestions ?? [];
      } catch {
        tier2 = [];
      }
    }
    let chipsForSid;
    let suggestions = [];
    function retryLast() {
      if (!sessionId) return;
      const lastUser = [...cards].reverse().find((c) => c.kind === "user");
      const text = lastUser?.text;
      if (!text) return;
      void api.sendMessage({ sessionId, text, clientId: `web_${Date.now()}` });
    }
    onMount(() => {
      ro = new ResizeObserver(() => {
      });
      let lastUserScrollTop = 0;
      const onChatScrollU = () => {
        lastUserScrollTop = scrollEl.scrollTop;
      };
      scrollEl.addEventListener("scroll", onChatScrollU, { passive: true });
      scrollCleanups.push(() => scrollEl.removeEventListener("scroll", onChatScrollU));
      io = new IntersectionObserver(
        (entries) => {
          if (!pinnedToBottom || !entries.some((en) => !en.isIntersecting)) return;
          const grew = Math.abs(scrollEl.scrollHeight - lastScrollHeight) > 2;
          const userScrolled = Math.abs(scrollEl.scrollTop - lastUserScrollTop) > 2;
          if (grew && !userScrolled) requestAnimationFrame(pinBottom);
          else
            pinnedToBottom = false;
          lastScrollHeight = scrollEl.scrollHeight;
        },
        { root: scrollEl, threshold: 0 }
      );
      let lastScrollHeight = scrollEl.scrollHeight;
      const onStreamGrew = () => {
        if (pinnedToBottom) requestAnimationFrame(pinBottom);
      };
      window.addEventListener("ocrc:stream-grew", onStreamGrew);
      scrollCleanups.push(() => window.removeEventListener("ocrc:stream-grew", onStreamGrew));
      const vv = window.visualViewport;
      const onVV = () => {
        if (pinnedToBottom) requestAnimationFrame(pinBottom);
      };
      vv?.addEventListener("resize", onVV);
      vvCleanup = () => vv?.removeEventListener("resize", onVV);
    });
    onDestroy(() => {
      ro?.disconnect();
      io?.disconnect();
      vvCleanup?.();
      for (const c of scrollCleanups) c();
      if (runTimer) clearInterval(runTimer);
    });
    sessionId = store_get($$store_subs ??= {}, "$page", page).params.sessionId ?? "";
    if (sessionId && sessionId !== windowForSid) {
      windowForSid = sessionId;
      visibleCount = FIRST_WINDOW;
      hasMoreOlder = true;
      loadingOlder = false;
    }
    feed = store_get($$store_subs ??= {}, "$feeds", feeds)[sessionId];
    busy = (() => {
      const server = store_get($$store_subs ??= {}, "$serverBusy", serverBusy)[sessionId] ?? false;
      if (server) return true;
      if (!feed || feed.order.length === 0) return false;
      return feed.order.some((id) => {
        const k = feed.byId[id]?.kind;
        return k === "thinking" || k === "streaming" || k === "think-stream";
      });
    })();
    if (busy && revertCutoff) revertCutoff = void 0;
    cards = cardsOf(feed);
    revertedCards = revertCutoff ? (() => {
      let cut = -1;
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards[i].messageId === revertCutoff) {
          cut = i;
          break;
        }
      }
      return cut === -1 ? cards : cards.slice(0, cut);
    })() : cards;
    shownCards = visibleCount >= revertedCards.length ? revertedCards : revertedCards.slice(-visibleCount);
    session = store_get($$store_subs ??= {}, "$sessionList", sessionList).find((s) => s.id === sessionId);
    branch = session?.directory ? session.directory.replace(/\/+$/, "").split("/").pop() || "" : "";
    if (busy) {
      if (runSession !== sessionId) {
        runSession = sessionId;
        runStart = 0;
      }
      if (!runStart && typeof window !== "undefined") {
        runStart = Date.now();
        runElapsed = 0;
        if (runTimer) clearInterval(runTimer);
        runTimer = setInterval(
          () => {
            runElapsed = Math.floor((Date.now() - runStart) / 1e3);
          },
          1e3
        );
      }
    } else {
      runStart = 0;
      runElapsed = 0;
      runSession = "";
      if (runTimer) {
        clearInterval(runTimer);
        runTimer = void 0;
      }
    }
    lastCard = cards.length ? cards[cards.length - 1] : null;
    if (sessionId) {
      checkReverted(sessionId);
    }
    if (!busy && lastCard?.kind === "assistant" && sessionId && lastCard.id) fetchSuggestions(sessionId, lastCard.id);
    if (sessionId !== chipsForSid) {
      chipsForSid = sessionId;
      chipsDismissed = false;
    }
    {
      const chipGate = busy || chipsDismissed || !store_get($$store_subs ??= {}, "$composerEmpty", composerEmpty) || !feed || store_get($$store_subs ??= {}, "$sessionBooting", sessionBooting);
      if (chipGate) suggestions = [];
      else if (tier2.length > 0) suggestions = tier2;
      else if (cards.length === 0) suggestions = STARTERS;
      else suggestions = [];
    }
    scrollKey = `${sessionId}:${feed?.lastSeq ?? 0}:${cards.length}`;
    if (scrollKey !== lastSeen) {
      lastSeen = scrollKey;
      tick().then(() => {
      });
    }
    $$renderer2.push(`<div class="chat svelte-eho102"><div class="sub-header svelte-eho102"><div class="left svelte-eho102"><button class="back svelte-eho102" aria-label="返回会话列表"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg></button> `);
    if (
      // The composer floats over the chat (mobile), so the chat reserves its height
      // (--composer-h) plus the keyboard inset (--kb) as bottom padding — otherwise
      // the latest messages sit hidden behind the box / keyboard.
      // keep latest pinned as the box grows
      // Scrollbar width → --sbw (the composer insets by it to stay aligned
      // with the transcript column, which lives inside the scroller).
      // Bottom sentinel: card upserts bump the feed seq (re-pins via scrollKey),
      // but content can also grow WITHOUT a new card — markdown re-flow after a
      // code block closes, tool-output rAF flushes. The observer catches those:
      // while pinned, any frame where the end marker left the viewport re-pins.
      // User-scroll detection: scrollTop only moves when the USER scrolls —
      // content growth (streaming deltas, reflow) changes scrollHeight under a
      // stationary scrollTop. The old IO unpin fired on growth (d > 24px) and
      // unlatched auto-follow ("↓ 最新" mid-stream). Yield ONLY on real scroll.
      // content grew — keep following
      // genuine user scroll — yield
      // sdelta growth does not change scrollKey (no new card/seq) — without this
      // listener the re-pin machinery was blind between snapshot cards and the
      // follow broke mid-stream ("↓ 最新" while running).
      // The keyboard/toolbar shifts the composer via --kb; re-pin the latest message
      // above it (only when already at the bottom, so scroll-up isn't fought).
      !store_get($$store_subs ??= {}, "$leftPanelOpen", leftPanelOpen)
    ) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="expand svelte-eho102" title="Expand left panel" aria-label="展开左侧面板"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"></path></svg></button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    SessionSwitcher($$renderer2, {
      activeId: sessionId,
      interactive: !store_get($$store_subs ??= {}, "$leftPanelOpen", leftPanelOpen) || isMobile
    });
    $$renderer2.push(`<!----> `);
    if (branch) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="branch mono svelte-eho102">${escape_html(branch)}</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> <div class="right svelte-eho102">`);
    if (busy) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="pill running mono svelte-eho102"><span class="dot svelte-eho102" aria-hidden="true"></span> 运行中 ${escape_html(fmtRunTime(runElapsed))}</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      if (reverted) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="restore mono svelte-eho102" title="恢复被撤销的轮次">恢复上一轮</button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <span class="idle mono svelte-eho102">空闲</span>`);
    }
    $$renderer2.push(`<!--]--> <button class="inspect svelte-eho102" aria-label="Inspector"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="14" y2="17"></line></svg></button> <button${attr_class("pane-toggle svelte-eho102", void 0, {
      "open": store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen)
    })}${attr("title", store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen) ? "收起面板" : "打开面板")}${attr("aria-label", store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen) ? "收起面板" : "打开面板")}${attr("aria-expanded", store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen))}>`);
    if (store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path><path d="m8 9 3 3-3 3"></path></svg>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path><path d="m10 15-3-3 3-3"></path></svg>`);
    }
    $$renderer2.push(`<!--]--></button></div></div> <div${attr_class("stream conversation-emerald svelte-eho102", void 0, {
      "suppressed": store_get($$store_subs ??= {}, "$feedResyncing", feedResyncing)
    })} aria-live="polite">`);
    if (cards.length > 0 && (cards.length > visibleCount || hasMoreOlder)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="load-earlier mono svelte-eho102"${attr("disabled", loadingOlder, true)}>${escape_html(loadingOlder ? "加载中…" : "加载更早消息")}</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <!--[-->`);
    const each_array = ensure_array_like(shownCards);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let card = each_array[$$index];
      const isLastAssistant = card.id === lastCard?.id && card.kind === "assistant" && !busy;
      const revertTarget = isLastAssistant && lastCard?.kind === "assistant" ? lastCard.messageId : void 0;
      Card($$renderer2, {
        card,
        onRetry: retryLast,
        onRegenerate: isLastAssistant ? regenerateLast : void 0,
        onRevert: isLastAssistant && revertTarget ? () => revertLast(revertTarget) : void 0
      });
    }
    $$renderer2.push(`<!--]--> <div class="stream-end svelte-eho102" aria-hidden="true"></div> `);
    if (cards.length === 0) {
      $$renderer2.push("<!--[0-->");
      if (!feed) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="loading mono svelte-eho102" aria-label="Loading conversation"><span class="ldot svelte-eho102"></span><span class="ldot svelte-eho102"></span><span class="ldot svelte-eho102"></span></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<div class="empty svelte-eho102"><svg class="empty-mark svelte-eho102" viewBox="0 0 64 64" fill="none" stroke-width="8" stroke-linecap="round" aria-hidden="true"><path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)" opacity=".85"></path><circle cx="49" cy="20" r="6" fill="var(--accent)" stroke="none"></circle></svg> <p class="empty-title svelte-eho102">要让 agent 做什么？</p> <p class="empty-hint svelte-eho102">在下方描述任务——它将在本项目目录中运行。需要时可附上图片。</p></div>`);
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div> `);
    if (!pinnedToBottom && cards.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="jump svelte-eho102" aria-label="跳到最新"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path></svg> 最新</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="composer-float svelte-eho102">`);
    Suggestions($$renderer2, {
      suggestions,
      onPick: (text) => composerDraft.set({ text, nonce: Date.now() }),
      onDismiss: () => {
        chipsDismissed = true;
        suggestions = [];
      }
    });
    $$renderer2.push(`<!----> `);
    Composer($$renderer2, { sessionId });
    $$renderer2.push(`<!----></div> `);
    PlanHud($$renderer2, { sessionId, onJump: (sid) => goto("/" + sid) });
    $$renderer2.push(`<!---->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
export {
  _page as default
};
