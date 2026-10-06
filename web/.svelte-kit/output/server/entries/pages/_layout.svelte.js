import { b as attr_class, a as attr, g as store_get, h as stringify, u as unsubscribe_stores, d as bind_props, f as ensure_array_like, c as attr_style, s as slot } from "../../chunks/index.js";
import { e as escape_html, o as onDestroy, b as onMount, c as createEventDispatcher } from "../../chunks/index-client.js";
import { x as writable, h as get } from "../../chunks/exports.js";
import { l as latency, d as connection, I as Icon, o as themeMode, C as Card, m as summarizeTodos, M as MarkdownView, k as sidePane, H as HOMES, p as page, n as newSessionOpen, c as channelsOpen, h as html, g as plusMenuOpen, i as inspectorOpen, e as leftPanelOpen, j as sessionBooting, f as feedResyncing } from "../../chunks/summarizeTodos.js";
import { a as afterNavigate } from "../../chunks/client.js";
import { u as updated } from "../../chunks/index2.js";
import { o as getToken, p as handleAuthFailure, w as sessionList, n as feeds, d as agentAccent, j as backends, c as accentOverrides, A as ACCENT_BG, a as ACCENT_HEX, b as ACCENT_LINE, e as api, l as cardsOf, z as setHistory, k as can, m as currentBackendId, t as pairHint, f as applyAgentTheme, h as auth, s as loadCapabilities, r as loadBackends, D as viewedSessionId, u as pruneFeeds, C as upsertCards, B as upsertCard, q as isSeqGap, v as serverBusy, g as applyStreamDelta, y as setFeedEpoch } from "../../chunks/capabilities.js";
import { N as fallback } from "../../chunks/environment.js";
import "@sveltejs/kit/internal";
import "../../chunks/shared.js";
const BACKOFF = [2e3, 4e3, 8e3, 16e3, 3e4];
function withToken(url) {
  const t = getToken();
  if (!t) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(t)}`;
}
function createWsClient(opts) {
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let pingSentAt = 0;
  let closed = false;
  let everConnected = false;
  const pending2 = [];
  function setStatus(s) {
    connection.set(s);
    opts.onStatus?.(s);
  }
  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  }
  function schedulePing() {
    pingTimer = setTimeout(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        pingSentAt = performance.now();
        ws.send(JSON.stringify({ type: "ping" }));
        pongTimer = setTimeout(() => {
          ws?.close();
          reconnect();
        }, 45e3);
      }
    }, 25e3);
  }
  function connect() {
    if (closed) return;
    setStatus("reconnecting");
    try {
      ws = new WebSocket(withToken(opts.url));
    } catch {
      reconnect();
      return;
    }
    ws.onopen = () => {
      reconnectAttempt = 0;
      setStatus("connected");
      if (pending2.length > 50) pending2.splice(0, pending2.length - 50);
      for (const data of pending2.splice(0)) ws?.send(data);
      if (everConnected) opts.onReconnect?.();
      everConnected = true;
      schedulePing();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        console.warn("[ws] unparseable frame", err);
        return;
      }
      try {
        if (msg.type === "pong") {
          if (pongTimer) {
            clearTimeout(pongTimer);
            pongTimer = null;
          }
          if (pingSentAt) {
            latency.set(Math.round(performance.now() - pingSentAt));
          }
          schedulePing();
          return;
        }
        opts.onMessage?.(msg);
      } catch {
      }
    };
    ws.onclose = () => {
      clearTimers();
      if (!closed) reconnect();
    };
    ws.onerror = () => {
      ws?.close();
    };
  }
  function forceReconnect() {
    reconnectAttempt = 0;
    clearTimers();
    if (closed) return;
    if (ws) {
      try {
        ws.close();
      } catch {
      }
    } else connect();
  }
  function reconnect() {
    clearTimers();
    if (closed) return;
    setStatus("reconnecting");
    const delay = BACKOFF[Math.min(reconnectAttempt, BACKOFF.length - 1)];
    reconnectAttempt += 1;
    if (reconnectAttempt === 4) {
      void fetch("/api/me", { headers: { Authorization: `Bearer ${getToken() ?? ""}` } }).then((r) => {
        if (r.status === 401) handleAuthFailure();
      }).catch(() => {
      });
    }
    reconnectTimer = setTimeout(() => void connect(), delay);
  }
  void connect();
  return {
    forceReconnect,
    send(msg) {
      const data = JSON.stringify(msg);
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      else pending2.push(data);
    },
    close() {
      closed = true;
      clearTimers();
      pending2.length = 0;
      ws?.close();
      ws = null;
      setStatus("offline");
    }
  };
}
let current = null;
function setWsSend(fn) {
  current = fn;
}
function wsSend(msg) {
  current?.(msg);
}
let baseline = /* @__PURE__ */ new Map();
const pending = /* @__PURE__ */ new Set();
let viewed;
let titleTimer;
let flash = false;
function refreshTitle() {
  if (typeof document === "undefined") return;
  const base = document.title.replace(/^(🔔 [\d]+ 新动态 — )/, "") || "ocrc";
  if (pending.size === 0) {
    if (titleTimer) {
      clearInterval(titleTimer);
      titleTimer = void 0;
    }
    flash = false;
    document.title = base;
    return;
  }
  if (titleTimer) return;
  document.title = `🔔 ${pending.size} 新动态 — ${base}`;
  titleTimer = setInterval(() => {
    flash = !flash;
    document.title = flash ? `🔔 ${pending.size} 新动态 — ${base}` : base;
  }, 1200);
}
function setViewedSession(id) {
  viewed = id;
  if (id) {
    pending.delete(id);
    refreshTitle();
  }
}
function noteSessionActivity(rows) {
  for (const r of rows) {
    const prev = baseline.get(r.id);
    baseline.set(r.id, r.lastActiveAt);
    if (prev === void 0 || r.id === viewed) continue;
    if (r.lastActiveAt > prev + 1500) {
      pending.add(r.id);
      refreshTitle();
    }
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      pending.clear();
      refreshTitle();
    }
  });
}
const paletteOpen = writable(false);
function Titlebar($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let userLabel, userInitial;
    let email = fallback($$props["email"], "");
    let build = fallback($$props["build"], "");
    let onPalette = $$props["onPalette"];
    let installEvent = fallback($$props["installEvent"], null);
    let onInstall = fallback($$props["onInstall"], () => {
    });
    let drawerLeft = fallback($$props["drawerLeft"], false);
    let drawerRight = fallback($$props["drawerRight"], false);
    let onToggleLeft = fallback($$props["onToggleLeft"], () => {
    });
    let onToggleRight = fallback($$props["onToggleRight"], () => {
    });
    let newButtonAnchor = fallback($$props["newButtonAnchor"], null);
    function statusText(status) {
      if (status === "connected") return "live";
      if (status === "reconnecting") return "reconnecting";
      return "offline";
    }
    userLabel = email || "you@local";
    userInitial = userLabel.charAt(0).toUpperCase();
    $$renderer2.push(`<header class="titlebar svelte-hhath1"><button${attr_class("iconbtn svelte-hhath1", void 0, { "active": drawerLeft })} aria-label="Sessions">`);
    Icon($$renderer2, { name: "menu", size: 18 });
    $$renderer2.push(`<!----></button> <div class="brand svelte-hhath1" title="ocrc"><svg class="brand-mark svelte-hhath1" viewBox="0 0 64 64" fill="none" stroke-width="8" stroke-linecap="round" aria-hidden="true"><path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)"></path><circle cx="49" cy="20" r="6" fill="var(--accent)" stroke="none"></circle></svg> <span class="wordmark svelte-hhath1"><b class="svelte-hhath1">ocrc</b></span></div> <button class="new-session svelte-hhath1" title="新建会话、命令面板…"><span class="new-icon svelte-hhath1" aria-hidden="true">+</span> <span class="new-label svelte-hhath1">新建</span> <span class="new-caret svelte-hhath1" aria-hidden="true">`);
    Icon($$renderer2, { name: "caret-down", size: 9 });
    $$renderer2.push(`<!----></span></button> <button class="palette-trigger svelte-hhath1" title="搜索会话与命令 (⌘K)"><span class="palette-icon svelte-hhath1" aria-hidden="true">`);
    Icon($$renderer2, { name: "search", size: 14 });
    $$renderer2.push(`<!----></span> <span class="palette-label svelte-hhath1">搜索会话与命令…</span> <kbd class="palette-keycap mono svelte-hhath1">⌘K</kbd></button> <span class="spacer svelte-hhath1"></span> <button class="themebtn channels-btn svelte-hhath1" title="机器人与通道" aria-label="机器人与通道"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><path d="M8 16h0M16 16h0"></path></svg></button> <button class="themebtn theme-btn svelte-hhath1"${attr("title", store_get($$store_subs ??= {}, "$themeMode", themeMode) === "auto" ? "主题：跟随系统" : store_get($$store_subs ??= {}, "$themeMode", themeMode) === "light" ? "主题：浅色" : "主题：深色")} aria-label="Toggle color theme">`);
    if (store_get($$store_subs ??= {}, "$themeMode", themeMode) === "light") {
      $$renderer2.push("<!--[0-->");
      Icon($$renderer2, { name: "sun", size: 15 });
    } else if (store_get($$store_subs ??= {}, "$themeMode", themeMode) === "dark") {
      $$renderer2.push("<!--[1-->");
      Icon($$renderer2, { name: "moon", size: 15 });
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"></path><path d="M9.6 15.6 12 8.2l2.4 7.4M10.5 13.3h3" stroke="var(--bg-elev, #fff)" stroke-width="1.5"></path></svg>`);
    }
    $$renderer2.push(`<!--]--></button> <span${attr_class(`connection-pill ${stringify(store_get($$store_subs ??= {}, "$connection", connection))}`, "svelte-hhath1")}${attr("title", `WebSocket: ${stringify(statusText(store_get($$store_subs ??= {}, "$connection", connection)))}`)}><span class="dot-wrap svelte-hhath1" aria-hidden="true"><span class="dot svelte-hhath1"></span></span> <span class="connection-state svelte-hhath1">${escape_html(statusText(store_get($$store_subs ??= {}, "$connection", connection)))}</span> `);
    if (store_get($$store_subs ??= {}, "$connection", connection) === "connected") {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span${attr_class("connection-latency mono svelte-hhath1", void 0, {
        "slow": store_get($$store_subs ??= {}, "$latency", latency) > 300
      })} title="WebSocket 往返延迟">${escape_html(store_get($$store_subs ??= {}, "$latency", latency))}ms</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></span> `);
    if (installEvent) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="install svelte-hhath1">Install</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <button${attr_class("iconbtn svelte-hhath1", void 0, { "active": drawerRight })} aria-label="Inspector"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="14" y2="17"></line></svg></button> <div class="user svelte-hhath1"${attr("title", build ? `UI build ${build}` : void 0)}><span class="user-email mono svelte-hhath1">${escape_html(userLabel)}</span> <span class="avatar mono svelte-hhath1" aria-hidden="true">${escape_html(userInitial)}</span></div></header>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, {
      email,
      build,
      onPalette,
      installEvent,
      onInstall,
      drawerLeft,
      drawerRight,
      onToggleLeft,
      onToggleRight,
      newButtonAnchor
    });
  });
}
function OfflineBanner($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    if (store_get($$store_subs ??= {}, "$connection", connection) !== "connected") {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div${attr_class("banner svelte-l46k7l", void 0, {
        "offline": store_get($$store_subs ??= {}, "$connection", connection) === "offline"
      })} role="status">`);
      if (store_get($$store_subs ??= {}, "$connection", connection) === "reconnecting") {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`Reconnecting…`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`Offline — live updates paused`);
      }
      $$renderer2.push(`<!--]--> <button class="svelte-l46k7l">立即重连</button></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
const KEY$1 = "ocrc.pinnedSessions";
function load$1() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY$1);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function persist$1(ids) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY$1, JSON.stringify(ids));
  } catch {
  }
}
function createPins() {
  const { subscribe, update } = writable(load$1());
  return {
    subscribe,
    toggle(id) {
      update((ids) => {
        const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
        persist$1(next);
        return next;
      });
    }
  };
}
const pinnedSessions = createPins();
const activeWorkspace = writable(null);
const KEY = "ocrc.archived.v1";
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function persist(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
  }
}
const store = writable(new Set(load()));
const archivedSessions = {
  subscribe: store.subscribe,
  has: (ids, id) => ids.has(id),
  toggle(id) {
    store.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist([...next]);
      return next;
    });
  }
};
function filterByWorkspace(sessions, workspace) {
  if (!workspace) return sessions;
  return sessions.filter((s) => (s.directory ?? "") === workspace);
}
function remoteHostOf(s) {
  const m = s.backendId?.match(/^remote:(.+)$/);
  return m?.[1];
}
function repoName(dir) {
  if (!dir) return "";
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "";
}
function matchesQuery(s, rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const bare = s.id.includes("_") ? s.id.slice(s.id.indexOf("_") + 1) : s.id;
  const haystack = [s.title ?? "", repoName(s.directory), remoteHostOf(s) ?? "", bare.slice(-8)];
  return haystack.some((field) => field.toLowerCase().includes(q));
}
function groupByProject(rows) {
  const byKey = /* @__PURE__ */ new Map();
  for (const s of rows) {
    const dir = s.directory;
    const host = remoteHostOf(s);
    const key = dir ? `dir:${dir}` : host ? `@${host}` : "@other";
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        label: repoName(dir) || host || "未分组",
        remote: !dir && !!host,
        remoteHost: !dir ? host : void 0,
        rows: []
      };
      byKey.set(key, g);
    }
    g.rows.push(s);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  groups.sort((a, b) => newest(b) - newest(a));
  return groups;
}
function newest(g) {
  return g.rows.reduce((max, s) => Math.max(max, s.lastActiveAt), 0);
}
function partitionTime(rows, pinnedIds) {
  const sorted = [...rows].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return {
    pinned: sorted.filter((s) => pinnedIds.includes(s.id)),
    recent: sorted.filter((s) => !pinnedIds.includes(s.id))
  };
}
function SessionList($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let statuses, byAgent, workspaceScoped, searched, live, timeBuckets, projectGroups;
    let activeId = fallback($$props["activeId"], void 0);
    let onSelect = fallback($$props["onSelect"], void 0);
    let agentId = fallback($$props["agentId"], void 0);
    let agentName = fallback($$props["agentName"], void 0);
    const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1e3;
    function isOnline(lastActiveAt, conn) {
      return conn === "connected" && Date.now() - lastActiveAt < ACTIVE_WINDOW_MS;
    }
    function isBusy(sid, all) {
      const f = all[sid];
      if (!f || f.order.length === 0) return false;
      return f.order.some((id) => {
        const k = f.byId[id]?.kind;
        return k === "thinking" || k === "streaming" || k === "think-stream";
      });
    }
    function isWaiting(sid, all) {
      const f = all[sid];
      if (!f || f.order.length === 0) return false;
      const last = f.byId[f.order[f.order.length - 1]];
      return last?.kind === "approval";
    }
    function statusFor(s, all, conn) {
      if (isBusy(s.id, all)) return "busy";
      if (isWaiting(s.id, all)) return "wait";
      if (isOnline(s.lastActiveAt, conn)) return "idle";
      return "offline";
    }
    function formatTime(ts) {
      const diff = Date.now() - ts;
      const m = Math.floor(diff / 6e4);
      if (m < 1) return "now";
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h`;
      return `${Math.floor(h / 24)}d`;
    }
    function shortId(id) {
      const bare = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
      return bare.slice(-8);
    }
    const MODE_KEY = "ocrc.railGroup.v1";
    let mode = "project";
    try {
      mode = localStorage.getItem(MODE_KEY) === "time" ? "time" : "project";
    } catch {
    }
    const COLLAPSE_KEY = "ocrc.railCollapsed.v1";
    let collapsed = new Set((() => {
      try {
        const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]");
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    })());
    let query = "";
    let showArchived = false;
    let editing = null;
    let draft = "";
    let renaming = null;
    let deleting = null;
    let menuFor = null;
    onDestroy(() => {
      menuFor = null;
    });
    statuses = new Map(store_get($$store_subs ??= {}, "$sessionList", sessionList).map((s) => [
      s.id,
      statusFor(s, store_get($$store_subs ??= {}, "$feeds", feeds), store_get($$store_subs ??= {}, "$connection", connection))
    ]));
    byAgent = agentId && mode === "time" ? store_get($$store_subs ??= {}, "$sessionList", sessionList).filter((s) => s.backendId === agentId || !s.backendId && agentId === "opencode") : store_get($$store_subs ??= {}, "$sessionList", sessionList);
    workspaceScoped = filterByWorkspace(byAgent, store_get($$store_subs ??= {}, "$activeWorkspace", activeWorkspace));
    searched = workspaceScoped.filter((s) => matchesQuery(s, query));
    live = searched.filter((s) => !store_get($$store_subs ??= {}, "$archivedSessions", archivedSessions).has(s.id));
    [
      ...workspaceScoped.filter((s) => store_get($$store_subs ??= {}, "$archivedSessions", archivedSessions).has(s.id))
    ].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    timeBuckets = partitionTime(live, store_get($$store_subs ??= {}, "$pinnedSessions", pinnedSessions));
    projectGroups = groupByProject(live);
    function row($$renderer3, s, archived) {
      $$renderer3.push(`<a${attr("href", `/${stringify(s.id)}/`)}${attr_class("session svelte-1h8243g", void 0, {
        "active": activeId === s.id,
        "busy": statuses.get(s.id) === "busy"
      })}><div class="line1 svelte-1h8243g"><span${attr_class(`dot ${stringify(statuses.get(s.id) ?? "offline")}`, "svelte-1h8243g")}><span class="sr-only svelte-1h8243g">${escape_html(statuses.get(s.id) ?? "offline")}</span></span> `);
      if (editing === s.id) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<input class="rename-input svelte-1h8243g"${attr("value", draft)}${attr("disabled", renaming === s.id, true)} placeholder="Session title" aria-label="Session title"/>`);
      } else {
        $$renderer3.push("<!--[-1-->");
        $$renderer3.push(`<span class="title svelte-1h8243g">${escape_html(s.title || "Untitled session")}</span> `);
        if (store_get($$store_subs ??= {}, "$pinnedSessions", pinnedSessions).includes(s.id)) {
          $$renderer3.push("<!--[0-->");
          $$renderer3.push(`<span class="pin-dot svelte-1h8243g" aria-label="已钉住">●</span>`);
        } else {
          $$renderer3.push("<!--[-1-->");
        }
        $$renderer3.push(`<!--]--> <span class="actions svelte-1h8243g"><button class="act rename svelte-1h8243g" title="重命名会话" aria-label="重命名会话"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg></button> <button${attr_class("act pin svelte-1h8243g", void 0, {
          "on": store_get($$store_subs ??= {}, "$pinnedSessions", pinnedSessions).includes(s.id)
        })}${attr("title", store_get($$store_subs ??= {}, "$pinnedSessions", pinnedSessions).includes(s.id) ? "取消钉住" : "钉住")} aria-label="钉住会话"><svg width="13" height="13" viewBox="0 0 24 24"${attr("fill", store_get($$store_subs ??= {}, "$pinnedSessions", pinnedSessions).includes(s.id) ? "currentColor" : "none")} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg></button> <button class="act arch svelte-1h8243g"${attr("title", "归档")}${attr("aria-label", "归档")}>`);
        {
          $$renderer3.push("<!--[-1-->");
          $$renderer3.push(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>`);
        }
        $$renderer3.push(`<!--]--></button> <button class="act trash svelte-1h8243g" title="删除会话" aria-label="删除会话"${attr("disabled", deleting === s.id, true)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></button> <button${attr_class("act mmore svelte-1h8243g", void 0, { "on": menuFor === s.id })} title="会话操作" aria-label="会话操作"${attr("aria-expanded", menuFor === s.id)}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button> `);
        if (menuFor === s.id) {
          $$renderer3.push("<!--[0-->");
          $$renderer3.push(`<span class="rowmenu svelte-1h8243g" role="menu"><button role="menuitem" class="svelte-1h8243g">重命名</button> <button role="menuitem" class="svelte-1h8243g">${escape_html(store_get($$store_subs ??= {}, "$pinnedSessions", pinnedSessions).includes(s.id) ? "取消钉住" : "钉住")}</button> <button role="menuitem" class="svelte-1h8243g">${escape_html(store_get($$store_subs ??= {}, "$archivedSessions", archivedSessions).has(s.id) ? "取消归档" : "归档")}</button> <button role="menuitem" class="danger svelte-1h8243g">删除…</button></span>`);
        } else {
          $$renderer3.push("<!--[-1-->");
        }
        $$renderer3.push(`<!--]--></span>`);
      }
      $$renderer3.push(`<!--]--></div> <div class="meta mono svelte-1h8243g"><span class="id svelte-1h8243g">${escape_html(shortId(s.id))}</span> `);
      if (s.directory) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<span class="sep svelte-1h8243g">·</span><span class="repo svelte-1h8243g">${escape_html(s.directory.replace(/\/+$/, "").split("/").pop())}</span>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> <span class="sep svelte-1h8243g">·</span><span>${escape_html(formatTime(s.lastActiveAt))}</span> `);
      if (s.additions || s.deletions) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<span class="sep svelte-1h8243g">·</span> `);
        if (s.additions) {
          $$renderer3.push("<!--[0-->");
          $$renderer3.push(`<span class="add svelte-1h8243g">+${escape_html(s.additions)}</span>`);
        } else {
          $$renderer3.push("<!--[-1-->");
        }
        $$renderer3.push(`<!--]--> `);
        if (s.deletions) {
          $$renderer3.push("<!--[0-->");
          $$renderer3.push(`<span class="del svelte-1h8243g">−${escape_html(s.deletions)}</span>`);
        } else {
          $$renderer3.push("<!--[-1-->");
        }
        $$renderer3.push(`<!--]-->`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--></div> `);
      if (statuses.get(s.id) === "busy") {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<div class="progress svelte-1h8243g" aria-hidden="true"><span class="progress-fill svelte-1h8243g"></span></div>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--></a>`);
    }
    $$renderer2.push(`<div class="sidebar svelte-1h8243g"><div class="toolbar svelte-1h8243g"><div class="modes svelte-1h8243g" role="tablist" aria-label="分组方式"><button role="tab"${attr("aria-selected", mode === "project")}${attr_class("svelte-1h8243g", void 0, { "on": mode === "project" })}>项目</button> <button role="tab"${attr("aria-selected", mode === "time")}${attr_class("svelte-1h8243g", void 0, { "on": mode === "time" })}>时间</button></div> <button${attr_class("archbtn svelte-1h8243g", void 0, { "on": showArchived })}${attr("title", "归档")}${attr("aria-label", "归档")}>`);
    {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>`);
    }
    $$renderer2.push(`<!--]--></button></div> `);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="searchbox svelte-1h8243g"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg> <input placeholder="搜索会话 / 项目 / 主机"${attr("value", query)} aria-label="搜索会话" class="svelte-1h8243g"/> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (mode === "project") {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<!--[-->`);
      const each_array_1 = ensure_array_like(projectGroups);
      for (let $$index_2 = 0, $$length = each_array_1.length; $$index_2 < $$length; $$index_2++) {
        let g = each_array_1[$$index_2];
        $$renderer2.push(`<button${attr_class("group-head svelte-1h8243g", void 0, { "collapsed": collapsed.has(g.key) })}${attr("aria-expanded", !collapsed.has(g.key))}>`);
        if (g.remote) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<svg class="gicon cloud svelte-1h8243g" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98 6 6 0 0 0-11.7 1.62A3.5 3.5 0 0 0 6.5 19z"></path></svg>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<svg class="gicon folder svelte-1h8243g" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"></path></svg>`);
        }
        $$renderer2.push(`<!--]--> <span class="gh-label svelte-1h8243g">${escape_html(g.label)}</span> `);
        if (g.remote) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="gh-host mono svelte-1h8243g">${escape_html(g.remoteHost)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <span class="gh-spacer svelte-1h8243g"></span> <span class="gh-count svelte-1h8243g">${escape_html(g.rows.length)}</span> <span class="gh-caret svelte-1h8243g" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg></span></button> `);
        if (!collapsed.has(g.key)) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<!--[-->`);
          const each_array_2 = ensure_array_like(g.rows);
          for (let $$index_1 = 0, $$length2 = each_array_2.length; $$index_1 < $$length2; $$index_1++) {
            let s = each_array_2[$$index_1];
            row($$renderer2, s);
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]-->`);
      }
      $$renderer2.push(`<!--]--> `);
      if (live.length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="empty mono svelte-1h8243g">${escape_html(`no sessions on ${agentName ?? "this agent"} yet`)}</div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<!--[-->`);
      const each_array_3 = ensure_array_like([
        { key: "pinned", label: "Pinned", rows: timeBuckets.pinned },
        { key: "recent", label: "Recent", rows: timeBuckets.recent }
      ]);
      for (let $$index_4 = 0, $$length = each_array_3.length; $$index_4 < $$length; $$index_4++) {
        let group = each_array_3[$$index_4];
        if (group.rows.length) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="group-header mono svelte-1h8243g"><span class="gh-label svelte-1h8243g">${escape_html(group.label)}</span> <span class="gh-line svelte-1h8243g" aria-hidden="true"></span> <span class="gh-count svelte-1h8243g">${escape_html(group.rows.length)}</span></div> <!--[-->`);
          const each_array_4 = ensure_array_like(group.rows);
          for (let $$index_3 = 0, $$length2 = each_array_4.length; $$index_3 < $$length2; $$index_3++) {
            let s = each_array_4[$$index_3];
            row($$renderer2, s);
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]-->`);
      }
      $$renderer2.push(`<!--]--> `);
      if (live.length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="empty mono svelte-1h8243g">${escape_html(`no sessions on ${agentName ?? "this agent"} yet`)}</div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { activeId, onSelect, agentId, agentName });
  });
}
function RailFoot($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let label;
    let build = fallback($$props["build"], "");
    label = build || "dev";
    $$renderer2.push(`<div class="rail-foot svelte-aqr1j0"><span class="who mono svelte-aqr1j0"${attr("title", build ? `UI build ${build}` : "ocrc")}>${escape_html(label)}</span> <span class="sp svelte-aqr1j0"></span> <button class="fbtn svelte-aqr1j0"${attr("aria-label", `主题：${store_get($$store_subs ??= {}, "$themeMode", themeMode)}`)}${attr("title", `主题：${store_get($$store_subs ??= {}, "$themeMode", themeMode) === "auto" ? "跟随系统" : store_get($$store_subs ??= {}, "$themeMode", themeMode) === "light" ? "浅色" : "深色"}`)}>`);
    if (store_get($$store_subs ??= {}, "$themeMode", themeMode) === "light") {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" class="svelte-aqr1j0"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>`);
    } else if (store_get($$store_subs ??= {}, "$themeMode", themeMode) === "dark") {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" class="svelte-aqr1j0"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svelte-aqr1j0"><circle cx="12" cy="12" r="9"></circle><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"></path><path d="M9.6 15.6 12 8.2l2.4 7.4M10.5 13.3h3" stroke="var(--bg-elev, #fff)" stroke-width="1.5"></path></svg>`);
    }
    $$renderer2.push(`<!--]--></button> <button class="fbtn svelte-aqr1j0" aria-label="机器人与通道" title="机器人与通道"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svelte-aqr1j0"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><path d="M8 16h0M16 16h0"></path></svg></button></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { build });
  });
}
function AgentPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let activeBackendId, activeAgent, agents, sessionCounts, activeCount, pushedCount, agentThemes;
    let activeId = fallback($$props["activeId"], void 0);
    let email = fallback($$props["email"], "");
    let build = fallback($$props["build"], "");
    let drawer = fallback($$props["drawer"], false);
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
    const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1e3;
    function isOnline(lastActiveAt, conn) {
      return conn === "connected" && Date.now() - lastActiveAt < ACTIVE_WINDOW_MS;
    }
    function themeFor(_overrides, id) {
      return agentAccent(id);
    }
    let scheduleCount = 0;
    let quickTimer;
    async function loadQuick() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await api.schedules();
        scheduleCount = (res.schedules ?? []).length;
      } catch {
      }
    }
    onMount(() => {
      void loadQuick();
      quickTimer = setInterval(() => void loadQuick(), 6e4);
      return () => {
        if (quickTimer) clearInterval(quickTimer);
      };
    });
    activeBackendId = store_get($$store_subs ??= {}, "$backends", backends)?.activeId ?? store_get($$store_subs ??= {}, "$backends", backends)?.backends[0]?.id ?? "opencode";
    activeAgent = store_get($$store_subs ??= {}, "$backends", backends)?.backends.find((b) => b.id === activeBackendId);
    agents = store_get($$store_subs ??= {}, "$backends", backends)?.backends ?? [];
    sessionCounts = Object.fromEntries((store_get($$store_subs ??= {}, "$backends", backends)?.backends ?? []).map((a) => [
      a.id,
      store_get($$store_subs ??= {}, "$sessionList", sessionList).filter((s) => s.backendId === a.id || !s.backendId && a.id === "opencode").length
    ]));
    activeCount = store_get($$store_subs ??= {}, "$sessionList", sessionList).filter((s) => (s.backendId === activeBackendId || !s.backendId && activeBackendId === "opencode") && isOnline(s.lastActiveAt, store_get($$store_subs ??= {}, "$connection", connection))).length;
    pushedCount = store_get($$store_subs ??= {}, "$sessionList", sessionList).filter((s) => (s.backendId === activeBackendId || !s.backendId && activeBackendId === "opencode") && (s.additions || s.deletions)).length;
    themeFor(store_get($$store_subs ??= {}, "$accentOverrides", accentOverrides), activeBackendId);
    agentThemes = Object.fromEntries(agents.map((a) => [
      a.id,
      themeFor(store_get($$store_subs ??= {}, "$accentOverrides", accentOverrides), a.id)
    ]));
    $$renderer2.push(`<div${attr_class("agent-panel svelte-wmno67", void 0, { "drawer": drawer })}><div class="panel svelte-wmno67">`);
    if (drawer && agents.length > 1) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="agents-label svelte-wmno67">Agents</div> <div class="switcher-row svelte-wmno67"><!--[-->`);
      const each_array = ensure_array_like(agents);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let a = each_array[$$index];
        const theme = agentThemes[a.id] ?? agentAccent(a.id);
        $$renderer2.push(`<button${attr_class("switch-pill svelte-wmno67", void 0, { "active": a.id === activeBackendId })}><span class="switch-tile svelte-wmno67"${attr_style(`background:${stringify(ACCENT_BG[theme])}; color:${stringify(ACCENT_HEX[theme])}; border-color:${stringify(ACCENT_LINE[theme])}`)}>${escape_html(glyph(a))}</span> <span${attr_class(`status-dot ${stringify(statusClass(a.status))}`, "svelte-wmno67")}${attr_style(`--dot:${stringify(ACCENT_HEX[theme])}`)}><span class="sr-only svelte-wmno67">${escape_html(statusClass(a.status))}</span></span> <span class="switch-name mono svelte-wmno67">${escape_html(a.name ?? a.id)}</span> <span class="switch-count mono svelte-wmno67">${escape_html(sessionCounts[a.id] ?? 0)}</span></button>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="actions-row svelte-wmno67"><button class="new-session svelte-wmno67"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg> <span>新建会话</span></button> `);
    if (!drawer) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="search-btn svelte-wmno67" title="搜索（⌘K）" aria-label="搜索会话与命令"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg></button> <button class="search-btn svelte-wmno67" title="收起会话栏 (⌘B)" aria-label="收起会话栏"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg></button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    if (drawer) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="mobile-search svelte-wmno67"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg> <span>搜索会话与命令</span></button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="list svelte-wmno67">`);
    SessionList($$renderer2, {
      activeId,
      agentId: activeBackendId,
      agentName: activeAgent?.name ?? activeAgent?.id
    });
    $$renderer2.push(`<!----></div> <div class="quick svelte-wmno67"><button class="quick-row svelte-wmno67" title="定时任务"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg> <span class="q-label svelte-wmno67">定时任务</span> <span class="q-count mono svelte-wmno67">${escape_html(scheduleCount)}</span></button></div> <div class="footer mono svelte-wmno67"><span>${escape_html(activeCount)} 活跃</span> <span class="sep svelte-wmno67">·</span> <span>${escape_html(pushedCount)} 已推送</span></div> `);
    if (!drawer) {
      $$renderer2.push("<!--[0-->");
      RailFoot($$renderer2, { build });
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { activeId, email, build, drawer });
  });
}
function SideChatTab($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let cards;
    let childId = $$props["childId"];
    const tick = 0;
    let text = "";
    let backfilledFor;
    async function backfill(id) {
      const feed = get(feeds)[id];
      if (feed && feed.order.length > 0) return;
      try {
        const res = await api.history(id, { limit: 60 });
        setHistory(id, res.cards ?? [], res.lastSeq ?? 0);
      } catch {
      }
    }
    onDestroy(() => {
      if (childId) wsSend({ type: "unsubscribe", sessionId: childId });
    });
    if (childId && childId !== backfilledFor) {
      backfilledFor = childId;
      void (async () => {
        await backfill(childId);
        const seq = get(feeds)[childId]?.lastSeq ?? 0;
        wsSend({ type: "subscribe", sessionId: childId, sinceSeq: seq });
      })();
    }
    cards = childId ? cardsOf(store_get($$store_subs ??= {}, "$feeds", feeds)[childId] ?? null) : [];
    $$renderer2.push(`<div class="sc svelte-1ki800i"><div class="sc-hd svelte-1ki800i"><span class="hint mono svelte-1ki800i">辅助对话 · ${escape_html(
      // restore draft on failure
      cards.length
    )} 条</span> <button class="open mono svelte-1ki800i" title="在中栏打开此会话">中栏打开 ↗</button></div> <div class="sc-body svelte-1ki800i">`);
    const each_array = ensure_array_like(cards);
    if (each_array.length !== 0) {
      $$renderer2.push("<!--[-->");
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let c = each_array[i];
        Card($$renderer2, { card: c });
      }
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<div class="empty svelte-1ki800i">问点什么——回复实时流在这里。</div>`);
    }
    $$renderer2.push(`<!--]--></div> <div class="sc-input svelte-1ki800i"><textarea${attr("rows", 2)} placeholder="辅助对话…（↵ 发送）" aria-label="辅助对话输入" class="svelte-1ki800i">`);
    const $$body = escape_html(text);
    if ($$body) {
      $$renderer2.push(`${$$body}`);
    }
    $$renderer2.push(`</textarea> <button class="send svelte-1ki800i"${attr("disabled", !text.trim(), true)} aria-label="发送"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg></button></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { childId, tick });
  });
}
function TaskPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let done, pct;
    let sessionId = fallback($$props["sessionId"], void 0);
    let tick = fallback($$props["tick"], 0);
    let s = { total: 0, done: 0, items: [] };
    async function load2(id) {
      if (!id) {
        s = { total: 0, done: 0, items: [] };
        return;
      }
      try {
        const todos = await api.todo(id);
        if (id !== sessionId) return;
        s = summarizeTodos(todos);
      } catch {
      }
    }
    load2(sessionId);
    done = s.items.filter((it) => it.status === "done").length;
    pct = s.total ? Math.round(done / s.total * 100) : 0;
    $$renderer2.push(`<div class="task svelte-1h1y2gb"><div class="hd svelte-1h1y2gb">`);
    if (s.total) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="meta svelte-1h1y2gb">${escape_html(done)}/${escape_html(s.total)} · ${escape_html(pct)}%</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    if (s.total) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="bar svelte-1h1y2gb"><div class="fill svelte-1h1y2gb"${attr_style(`transform:scaleX(${stringify(pct / 100)})`)}></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="items svelte-1h1y2gb"><!--[-->`);
    const each_array = ensure_array_like(s.items);
    for (let i = 0, $$length = each_array.length; i < $$length; i++) {
      let it = each_array[i];
      $$renderer2.push(`<div${attr_class(`row ${stringify(it.status)}`, "svelte-1h1y2gb")}><span class="box svelte-1h1y2gb"><span class="dot svelte-1h1y2gb"></span> <span class="check svelte-1h1y2gb">✓</span></span> <span class="tx svelte-1h1y2gb">${escape_html(it.text)}</span></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (s.total === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="section-label svelte-1h1y2gb">暂无任务</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div>`);
    bind_props($$props, { sessionId, tick });
  });
}
function McpPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let tick = fallback($$props["tick"], 0);
    let servers = [];
    async function load2() {
      try {
        servers = await api.mcp();
      } catch {
      }
    }
    load2();
    $$renderer2.push(`<div class="mcp svelte-ehf8ic"><div class="list svelte-ehf8ic"><!--[-->`);
    const each_array = ensure_array_like(servers);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let m = each_array[$$index];
      $$renderer2.push(`<div${attr_class("row svelte-ehf8ic", void 0, { "off": m.status === "disabled" })}><span class="dot svelte-ehf8ic" aria-hidden="true"></span><span>${escape_html(m.name)}</span><span class="sr-only svelte-ehf8ic">${escape_html(m.status)}</span></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (servers.length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="label">未配置</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div>`);
    bind_props($$props, { tick });
  });
}
function SchedulesPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let tick = fallback($$props["tick"], 0);
    let rows = [];
    let armed;
    async function load2() {
      try {
        rows = (await api.schedules()).schedules ?? [];
      } catch {
      }
    }
    function specLabel(s) {
      if (s.kind === "every") return s.minutes >= 60 && s.minutes % 60 === 0 ? `every ${s.minutes / 60}h` : `every ${s.minutes}m`;
      return `daily ${s.time}`;
    }
    function rowLabel(r) {
      return r.name || r.prompt;
    }
    load2();
    $$renderer2.push(`<div class="schedules svelte-pijcyq"><div class="hd svelte-pijcyq"><button class="add svelte-pijcyq"${attr("aria-label", "新建计划")}>${escape_html("+")}</button></div> <div class="list svelte-pijcyq"><!--[-->`);
    const each_array = ensure_array_like(rows);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let r = each_array[$$index];
      $$renderer2.push(`<div${attr_class("row svelte-pijcyq", void 0, { "off": !r.enabled })}><button${attr_class("switch svelte-pijcyq", void 0, { "on": r.enabled })}${attr("aria-pressed", r.enabled)}${attr("aria-label", `${r.enabled ? "停用" : "启用"} ${rowLabel(r)}`)}><span class="dot svelte-pijcyq" aria-hidden="true"></span></button> <div class="txt svelte-pijcyq"><div class="prompt svelte-pijcyq">${escape_html(rowLabel(r))}</div> <div class="spec mono svelte-pijcyq">${escape_html(specLabel(r.spec))}</div></div> <button class="run svelte-pijcyq"${attr("disabled", !r.enabled, true)}${attr("aria-label", `立即运行 ${stringify(rowLabel(r))}`)} title="立即运行一次">▶</button> <button${attr_class("del svelte-pijcyq", void 0, { "arm": armed === r.id })}${attr("aria-label", `删除 ${stringify(rowLabel(r))}`)}>${escape_html(armed === r.id ? "确认?" : "✕")}</button></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (rows.length === 0 && true) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="label svelte-pijcyq">暂无</div> <div class="guide svelte-pijcyq">去会话里说「每天 9 点做 X」或「每 30 分钟检查一次」，agent 会直接创建；也可以点右上 + 手动新建。</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { tick });
  });
}
function SkillsPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let shown;
    let tick = fallback($$props["tick"], 0);
    let skills = [];
    async function load2() {
      try {
        skills = (await api.skills()).skills ?? [];
      } catch {
      }
    }
    shown = skills.slice(0, 18);
    load2();
    $$renderer2.push(`<div class="skills svelte-taxat6">`);
    if (skills.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div${attr_class("chips svelte-taxat6", void 0, { "clipped": skills.length > 18 })}><!--[-->`);
      const each_array = ensure_array_like(shown);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let s = each_array[$$index];
        $$renderer2.push(`<span class="chip svelte-taxat6"${attr("title", s.description ?? s.name)}>${escape_html(s.name)}</span>`);
      }
      $$renderer2.push(`<!--]--></div> `);
      if (skills.length > 18) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="more svelte-taxat6">${escape_html(`展开全部 ${skills.length}`)}</button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="label svelte-taxat6">none</div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { tick });
  });
}
function FilesPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let directory;
    let sessionId = fallback($$props["sessionId"], void 0);
    let tick = fallback($$props["tick"], 0);
    let files = [];
    let path = ".";
    let loading = false;
    async function load2() {
      if (!directory) return;
      loading = true;
      try {
        files = (await api.browse(directory, path)).files ?? [];
      } catch {
        files = [];
      } finally {
        loading = false;
      }
    }
    directory = store_get($$store_subs ??= {}, "$sessionList", sessionList).find((s) => s.id === sessionId)?.directory ?? "";
    if (directory) {
      load2();
    }
    $$renderer2.push(`<div class="files svelte-tp0rgj"><div class="crumb mono svelte-tp0rgj">`);
    {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<span class="mono">${escape_html(directory.split("/").pop() || "/")}</span>`);
    }
    $$renderer2.push(`<!--]--></div> <div class="list svelte-tp0rgj"><!--[-->`);
    const each_array = ensure_array_like(files);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let f = each_array[$$index];
      $$renderer2.push(`<button class="row svelte-tp0rgj"><span class="ico svelte-tp0rgj">${escape_html(f.type === "directory" ? "📁" : "📄")}</span> <span class="name svelte-tp0rgj">${escape_html(f.name)}</span></button>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (!loading && files.length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="label svelte-tp0rgj">empty</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (loading) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="label svelte-tp0rgj">…</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { sessionId, tick });
  });
}
function WorktreesPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let directory;
    let sessionId = fallback($$props["sessionId"], void 0);
    let tick = fallback($$props["tick"], 0);
    let rows = [];
    let armed;
    async function load2() {
      if (!directory) return;
      try {
        rows = (await api.worktrees(directory)).worktrees ?? [];
      } catch {
      }
    }
    directory = store_get($$store_subs ??= {}, "$sessionList", sessionList).find((s) => s.id === sessionId)?.directory ?? "";
    load2();
    $$renderer2.push(`<div class="wt svelte-148ev8e"><div class="hd svelte-148ev8e"><button class="add svelte-148ev8e"${attr("aria-label", "新建 worktree")}>${escape_html("+")}</button></div> <div class="list svelte-148ev8e">`);
    if (rows.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="rows svelte-148ev8e"><!--[-->`);
      const each_array = ensure_array_like(rows);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let w = each_array[$$index];
        $$renderer2.push(`<div class="row svelte-148ev8e"><span class="ico svelte-148ev8e" aria-hidden="true">🌿</span> <span class="name svelte-148ev8e">${escape_html(w.name)}</span> <button${attr_class("del svelte-148ev8e", void 0, { "arm": armed === w.name })}${attr("aria-label", `删除 ${stringify(w.name)}`)}>${escape_html(armed === w.name ? "确认?" : "✕")}</button></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<div class="label svelte-148ev8e">none</div>`);
    }
    $$renderer2.push(`<!--]--></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { sessionId, tick });
  });
}
function SubagentsPanel($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let sessionId = fallback($$props["sessionId"], void 0);
    let tick = fallback($$props["tick"], 0);
    let subs = [];
    let loading = false;
    async function load2() {
      if (!sessionId) {
        subs = [];
        return;
      }
      loading = true;
      try {
        const r = await api.subagents(sessionId);
        subs = [...r.subagents ?? []].sort((a, b) => Number(b.busy ?? false) - Number(a.busy ?? false));
      } catch {
        subs = [];
      } finally {
        loading = false;
      }
    }
    if (sessionId) {
      load2();
    }
    $$renderer2.push(`<div class="subs svelte-1s66f6s"><!--[-->`);
    const each_array = ensure_array_like(
      // Stash the parent link so the child session offers a way back (same
      // contract as PlanHud's jump rows).
      /* private mode */
      subs
    );
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let s = each_array[$$index];
      $$renderer2.push(`<button class="row svelte-1s66f6s"><span${attr_class("dot svelte-1s66f6s", void 0, {
        "live": s.busy,
        "done": !s.busy && s.total > 0 && s.done >= s.total
      })} aria-hidden="true"></span> <span class="meta svelte-1s66f6s"><span class="title svelte-1s66f6s">${escape_html(s.title || "…" + s.id.slice(-6))}</span> `);
      if (s.total > 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="count mono svelte-1s66f6s">${escape_html(s.done)}/${escape_html(s.total)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></span> `);
      if (s.busy) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="live-label svelte-1s66f6s">运行中</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></button>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (!loading && subs.length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="empty svelte-1s66f6s">该会话暂无子代理</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (loading) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="empty svelte-1s66f6s">…</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { sessionId, tick });
  });
}
function SubagentSessionTab($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let cards;
    let childId = $$props["childId"];
    let tick = fallback($$props["tick"], 0);
    let backfilledFor;
    async function backfill(id) {
      const feed = get(feeds)[id];
      if (feed && feed.order.length > 0) return;
      try {
        const res = await api.history(id, { limit: 60 });
        setHistory(id, res.cards ?? [], res.lastSeq ?? 0);
      } catch {
      }
    }
    onDestroy(() => {
      if (childId) wsSend({ type: "unsubscribe", sessionId: childId });
    });
    if (childId && childId !== backfilledFor) {
      backfilledFor = childId;
      void (async () => {
        await backfill(childId);
        const seq = get(feeds)[childId]?.lastSeq ?? 0;
        wsSend({ type: "subscribe", sessionId: childId, sinceSeq: seq });
      })();
    }
    if (childId && tick && get(feeds)[childId]?.order?.length === 0) void backfill(childId);
    cards = childId ? cardsOf(store_get($$store_subs ??= {}, "$feeds", feeds)[childId] ?? null) : [];
    $$renderer2.push(`<div class="t-wrap svelte-6fqea2"><div class="t-hd svelte-6fqea2"><span class="t-hint mono svelte-6fqea2">实况 · ${escape_html(cards.length)} 条</span> <button class="open svelte-6fqea2">在中栏打开此会话 →</button></div> <div class="t-body svelte-6fqea2">`);
    const each_array = ensure_array_like(cards);
    if (each_array.length !== 0) {
      $$renderer2.push("<!--[-->");
      for (let i = 0, $$length = each_array.length; i < $$length; i++) {
        let c = each_array[i];
        Card($$renderer2, { card: c });
      }
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<div class="empty svelte-6fqea2">（暂无输出——子代理开跑后这里实时滚动）</div>`);
    }
    $$renderer2.push(`<!--]--></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { childId, tick });
  });
}
function FileViewerTab($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let isMd, ext, fenced;
    let directory = $$props["directory"];
    let path = $$props["path"];
    const MAX_CHARS = 2e5;
    let content = "";
    let truncated = false;
    let binary = false;
    let failed = false;
    let loading = false;
    async function load2() {
      loading = true;
      failed = false;
      try {
        const r = await api.fileContent(directory, path);
        if (r.type !== "text") {
          binary = true;
          content = "";
          return;
        }
        binary = false;
        truncated = r.content.length > MAX_CHARS;
        content = truncated ? r.content.slice(0, MAX_CHARS) : r.content;
      } catch {
        failed = true;
      } finally {
        loading = false;
      }
    }
    if (directory && path) {
      load2();
    }
    isMd = /\.(md|markdown)$/i.test(path);
    ext = path.split(".").pop() ?? "";
    fenced = binary || failed ? "" : isMd ? content : "```" + ext + "\n" + content + "\n```";
    $$renderer2.push(`<div class="fv svelte-va1nfd">`);
    if (truncated) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="trunc label svelte-va1nfd">文件超过 ${escape_html(MAX_CHARS.toLocaleString())} 字符，已截断显示</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="body svelte-va1nfd">`);
    if (loading) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="hint label svelte-va1nfd">…</div>`);
    } else if (failed) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<div class="hint label svelte-va1nfd">读取失败</div>`);
    } else if (binary) {
      $$renderer2.push("<!--[2-->");
      $$renderer2.push(`<div class="hint label svelte-va1nfd">（二进制文件，无法预览）</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      MarkdownView($$renderer2, { src: isMd ? content : fenced });
    }
    $$renderer2.push(`<!--]--></div></div>`);
    bind_props($$props, { directory, path });
  });
}
function ToolOutputTab($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let statusLabel;
    let sessionId = $$props["sessionId"];
    let messageId = $$props["messageId"];
    let partId = $$props["partId"];
    let tick = fallback($$props["tick"], 0);
    let tool = "";
    let status = "";
    let command = "";
    let output = "";
    let error = "";
    let missing = false;
    let loading = true;
    let renderMd = false;
    try {
      renderMd = localStorage.getItem("ocrc.toolMd") === "1";
    } catch {
    }
    let pollTimer;
    let destroyed = false;
    let loadSeq = 0;
    function schedule() {
      if (destroyed) return;
      const seq = ++loadSeq;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(
        () => {
          if (!destroyed && seq === loadSeq) void load2(seq);
        },
        150
      );
    }
    function extractToolPart(parts) {
      return parts.find((p) => p?.id === partId && p?.type === "tool") ?? parts.find((p) => p?.type === "tool" && p?.state?.callID != null && p?.id === partId);
    }
    async function load2(seq) {
      try {
        const res = await api.messageRaw(sessionId, messageId);
        if (seq !== loadSeq || destroyed) return;
        const part = extractToolPart(res?.parts ?? []);
        if (!part) {
          missing = true;
          return;
        }
        missing = false;
        tool = String(part.tool ?? "");
        const st = part.state ?? {};
        status = String(st.status ?? "pending");
        const input = st.input ?? {};
        command = String(input.command ?? input.cmd ?? input.filePath ?? input.description ?? "");
        output = typeof st.output === "string" ? st.output : "";
        error = typeof st.error === "string" ? st.error : "";
      } catch {
        if (seq === loadSeq) missing = true;
      } finally {
        if (seq === loadSeq) loading = false;
        if (!destroyed && seq === loadSeq && (status === "running" || status === "pending")) {
          clearTimeout(pollTimer);
          pollTimer = setTimeout(
            () => {
              if (!destroyed && seq === loadSeq) void load2(seq);
            },
            2e3
          );
        }
      }
    }
    onDestroy(() => {
      destroyed = true;
      clearTimeout(pollTimer);
    });
    if (sessionId && messageId) {
      loading = true, void load2(++loadSeq);
    }
    if (!loading && tick && (status === "running" || status === "pending" || missing)) schedule();
    statusLabel = status === "completed" || status === "done" ? "完成" : status === "error" ? "出错" : status === "running" ? "运行中" : status || "…";
    $$renderer2.push(`<div class="out svelte-1bw07gw"><div class="hd svelte-1bw07gw"><span class="tool mono svelte-1bw07gw">${escape_html(tool || "tool")}</span> <span${attr_class(`st mono ${stringify(status)}`, "svelte-1bw07gw")}>${escape_html(statusLabel)}</span> <span class="sp svelte-1bw07gw"></span> `);
    if (output) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button${attr_class("md-toggle mono svelte-1bw07gw", void 0, { "on": renderMd })} title="渲染为 Markdown / 原始输出">MD</button>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    if (command) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="cmd mono svelte-1bw07gw">${escape_html(command)}</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (loading) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="hint mono svelte-1bw07gw">…</div>`);
    } else if (missing) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<div class="hint mono svelte-1bw07gw">（找不到该工具调用的原始数据）</div>`);
    } else if (error) {
      $$renderer2.push("<!--[2-->");
      $$renderer2.push(`<pre class="body mono err svelte-1bw07gw">${escape_html(error)}</pre>`);
    } else if (output) {
      $$renderer2.push("<!--[3-->");
      if (renderMd) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="md-wrap svelte-1bw07gw">`);
        MarkdownView($$renderer2, { src: output });
        $$renderer2.push(`<!----></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<pre class="body mono svelte-1bw07gw">${escape_html(output)}</pre>`);
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="hint mono svelte-1bw07gw">${escape_html(status === "running" || status === "pending" ? "运行中——输出将在完成时出现" : "（无输出）")}</div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { sessionId, messageId, partId, tick });
  });
}
function GitTab($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let sessionId = fallback($$props["sessionId"], void 0);
    let tick = fallback($$props["tick"], 0);
    let branch = "";
    let status = [];
    let diffs = /* @__PURE__ */ new Map();
    let expanded = /* @__PURE__ */ new Set();
    let loading = true;
    let diffLoading = null;
    async function load2() {
      try {
        const v = await api.vcs(sessionId);
        branch = v?.branch ?? "";
        status = v?.status ?? [];
      } catch {
        branch = "";
        status = [];
      } finally {
        loading = false;
      }
    }
    const statusLabel = (s) => s === "added" ? "新增" : s === "deleted" ? "删除" : s === "modified" ? "修改" : s ?? "";
    load2();
    $$renderer2.push(`<div class="git svelte-1x813in"><div class="hd svelte-1x813in"><span class="branch mono svelte-1x813in">${escape_html(branch || "…")}</span> `);
    if (status.length) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="count mono svelte-1x813in">${escape_html(status.length)} 个文件</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    const each_array = ensure_array_like(status);
    if (each_array.length !== 0) {
      $$renderer2.push("<!--[-->");
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let f = each_array[$$index];
        $$renderer2.push(`<div class="file svelte-1x813in"><button class="row svelte-1x813in"${attr("aria-expanded", expanded.has(f.file))}><span${attr_class(`badge ${stringify(f.status)}`, "svelte-1x813in")}>${escape_html(statusLabel(f.status))}</span> <span class="path mono svelte-1x813in">${escape_html(f.file)}</span> <span class="delta mono svelte-1x813in">`);
        if (f.additions) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="add svelte-1x813in">+${escape_html(f.additions)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (f.deletions) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="del svelte-1x813in">−${escape_html(f.deletions)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></span></button> `);
        if (expanded.has(f.file)) {
          $$renderer2.push("<!--[0-->");
          if (diffLoading === f.file) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<div class="hint mono svelte-1x813in">…</div>`);
          } else if (diffs.get(f.file)) {
            $$renderer2.push("<!--[1-->");
            $$renderer2.push(`<pre class="patch mono svelte-1x813in">${escape_html(diffs.get(f.file))}</pre>`);
          } else {
            $$renderer2.push("<!--[-1-->");
            $$renderer2.push(`<div class="hint mono svelte-1x813in">（无改动内容）</div>`);
          }
          $$renderer2.push(`<!--]-->`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div>`);
      }
    } else {
      $$renderer2.push("<!--[!-->");
      if (!loading) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="hint svelte-1x813in">工作区干净</div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--> `);
    if (loading) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="hint svelte-1x813in">…</div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div>`);
    bind_props($$props, { sessionId, tick });
  });
}
function Inspector($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let seq, activeId, activeTab;
    let sessionId = fallback($$props["sessionId"], void 0);
    let tick = 0;
    let lastSeen = -1;
    let timer;
    function onVisible() {
      if (!document.hidden) tick += 1;
    }
    onDestroy(() => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    });
    let sideChatBusy = false;
    function tabIcon(t) {
      if (t.kind === "home") {
        switch (t.homeId) {
          case "tasks":
            return "tasks";
          case "files":
            return "files";
          case "subs":
            return "bot";
          case "skills":
            return "skill";
          case "schedules":
            return "clock";
          case "mcp":
            return "plug";
        }
        return "gear";
      }
      if (t.kind === "git") return "git";
      if (t.kind === "sidechat") return "chat";
      if (t.kind === "tool") return "terminal";
      if (t.kind === "file") return "files";
      return "cpu";
    }
    let sum = { total: 0, done: 0, items: [] };
    let loadedFor;
    async function refresh(sid) {
      if (!sid) return;
      try {
        const todos = await api.todo(sid);
        if (sid !== sessionId) return;
        loadedFor = sid;
        sum = summarizeTodos(todos);
      } catch {
      }
    }
    let loadedSid;
    store_get($$store_subs ??= {}, "$sessionList", sessionList).find((s) => s.id === sessionId);
    seq = sessionId ? store_get($$store_subs ??= {}, "$feeds", feeds)[sessionId]?.lastSeq ?? 0 : 0;
    if (seq !== lastSeen) {
      lastSeen = seq;
      clearTimeout(timer);
      if (typeof document === "undefined" || !document.hidden) {
        timer = setTimeout(() => tick += 1, 1e3);
      }
    }
    activeId = store_get($$store_subs ??= {}, "$sidePane", sidePane).activeId;
    activeTab = store_get($$store_subs ??= {}, "$sidePane", sidePane).tabs.find((t) => t.id === activeId);
    store_get($$store_subs ??= {}, "$sidePane", sidePane).tabs.findIndex((t) => t.id === activeId);
    if (sessionId !== loadedSid) {
      loadedSid = sessionId;
      void refresh(sessionId);
    }
    if (tick) {
      void refresh(sessionId);
    }
    $$renderer2.push(`<aside class="inspector svelte-gu3dqx"><div class="tabs svelte-gu3dqx" role="tablist"><!--[-->`);
    const each_array = ensure_array_like(store_get($$store_subs ??= {}, "$sidePane", sidePane).tabs);
    for (let i = 0, $$length = each_array.length; i < $$length; i++) {
      let t = each_array[i];
      $$renderer2.push(`<button${attr_class("tab svelte-gu3dqx", void 0, { "active": activeId === t.id })} role="tab"${attr("aria-selected", activeId === t.id)} draggable="true"${attr("title", t.kind === "file" ? t.path : t.title)}><span class="tico svelte-gu3dqx" aria-hidden="true">`);
      Icon($$renderer2, { name: tabIcon(t), size: 12 });
      $$renderer2.push(`<!----></span> <span class="dlabel svelte-gu3dqx">${escape_html(t.title)}</span> `);
      if (t.kind === "home" && t.homeId === "tasks" && sum.total > 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="tbadge mono svelte-gu3dqx">${escape_html(sum.done)}/${escape_html(sum.total)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <span class="closer svelte-gu3dqx" role="button" tabindex="-1"${attr("aria-label", `关闭 ${t.title}`)}>✕</span></button>`);
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (store_get($$store_subs ??= {}, "$sidePane", sidePane).tabs.length > 1) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<button class="tabs-more svelte-gu3dqx" title="页签操作" aria-label="页签操作">⋯</button> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="plus svelte-gu3dqx"><button class="plus-btn svelte-gu3dqx" aria-label="新建页签" title="新建页签">+</button> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> <button class="collapse-btn svelte-gu3dqx" title="收起面板" aria-label="收起面板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svelte-gu3dqx"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path><path d="m8 9 3 3-3 3"></path></svg></button></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="pane svelte-gu3dqx">`);
    if (activeTab?.kind === "home") {
      $$renderer2.push("<!--[0-->");
      if (activeTab.homeId === "tasks") {
        $$renderer2.push("<!--[0-->");
        if (store_get($$store_subs ??= {}, "$can", can)("todos")) {
          $$renderer2.push("<!--[0-->");
          TaskPanel($$renderer2, { sessionId, tick });
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<div class="na svelte-gu3dqx">此 agent 不支持任务面板</div>`);
        }
        $$renderer2.push(`<!--]-->`);
      } else if (activeTab.homeId === "files") {
        $$renderer2.push("<!--[1-->");
        FilesPanel($$renderer2, { sessionId, tick });
        $$renderer2.push(`<!----> <div class="gap svelte-gu3dqx"></div> `);
        if (store_get($$store_subs ??= {}, "$can", can)("worktrees")) {
          $$renderer2.push("<!--[0-->");
          WorktreesPanel($$renderer2, { sessionId, tick });
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]-->`);
      } else if (activeTab.homeId === "subs") {
        $$renderer2.push("<!--[2-->");
        if (store_get($$store_subs ??= {}, "$can", can)("todos")) {
          $$renderer2.push("<!--[0-->");
          SubagentsPanel($$renderer2, { sessionId, tick });
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<div class="na svelte-gu3dqx">此 agent 不支持子代理面板</div>`);
        }
        $$renderer2.push(`<!--]-->`);
      } else if (activeTab.homeId === "skills") {
        $$renderer2.push("<!--[3-->");
        if (store_get($$store_subs ??= {}, "$can", can)("skills")) {
          $$renderer2.push("<!--[0-->");
          SkillsPanel($$renderer2, { tick });
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<div class="na svelte-gu3dqx">此 agent 不支持 Skills</div>`);
        }
        $$renderer2.push(`<!--]-->`);
      } else if (activeTab.homeId === "schedules") {
        $$renderer2.push("<!--[4-->");
        SchedulesPanel($$renderer2, { tick });
      } else if (activeTab.homeId === "mcp") {
        $$renderer2.push("<!--[5-->");
        if (store_get($$store_subs ??= {}, "$can", can)("mcp")) {
          $$renderer2.push("<!--[0-->");
          McpPanel($$renderer2, { tick });
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<div class="na svelte-gu3dqx">此 agent 未配置 MCP</div>`);
        }
        $$renderer2.push(`<!--]-->`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else if (activeTab?.kind === "subagent") {
      $$renderer2.push("<!--[1-->");
      SubagentSessionTab($$renderer2, { childId: activeTab.childId, tick });
    } else if (activeTab?.kind === "file") {
      $$renderer2.push("<!--[2-->");
      FileViewerTab($$renderer2, { directory: activeTab.directory, path: activeTab.path });
    } else if (activeTab?.kind === "tool") {
      $$renderer2.push("<!--[3-->");
      ToolOutputTab($$renderer2, {
        sessionId: activeTab.sessionId,
        messageId: activeTab.messageId,
        partId: activeTab.partId,
        tick
      });
    } else if (activeTab?.kind === "git") {
      $$renderer2.push("<!--[4-->");
      GitTab($$renderer2, { sessionId, tick });
    } else if (activeTab?.kind === "sidechat") {
      $$renderer2.push("<!--[5-->");
      SideChatTab($$renderer2, { childId: activeTab.childId, tick });
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="launcher svelte-gu3dqx"><p class="l-title svelte-gu3dqx">打开面板</p> <p class="l-desc svelte-gu3dqx">选择要在侧栏中打开的面板。</p> <div class="l-list svelte-gu3dqx"><!--[-->`);
      const each_array_2 = ensure_array_like(HOMES);
      for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
        let h = each_array_2[$$index_2];
        $$renderer2.push(`<button class="l-card svelte-gu3dqx"><span class="l-ico svelte-gu3dqx" aria-hidden="true">`);
        if (h.homeId === "tasks") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><path d="M9 11l3 3 8-8"></path><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"></path></svg>`);
        } else if (h.homeId === "files") {
          $$renderer2.push("<!--[1-->");
          $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><path d="M13 2v7h7"></path></svg>`);
        } else if (h.homeId === "subs") {
          $$renderer2.push("<!--[2-->");
          $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path></svg>`);
        } else if (h.homeId === "skills") {
          $$renderer2.push("<!--[3-->");
          $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"></path></svg>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`);
        }
        $$renderer2.push(`<!--]--></span> <span class="l-text svelte-gu3dqx">${escape_html(h.title)} `);
        if (h.homeId === "tasks" && sum.total > 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="tbadge mono svelte-gu3dqx">${escape_html(sum.done)}/${escape_html(sum.total)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></span></button>`);
      }
      $$renderer2.push(`<!--]--> <div class="l-sep svelte-gu3dqx"></div> <button class="l-card svelte-gu3dqx"${attr("disabled", sideChatBusy, true)}><span class="l-ico svelte-gu3dqx" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span> <span class="l-text svelte-gu3dqx">辅助对话</span></button> <div class="l-sep svelte-gu3dqx"></div> <button class="l-card svelte-gu3dqx"><span class="l-ico svelte-gu3dqx" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="svelte-gu3dqx"><circle cx="6" cy="6" r="2.5"></circle><circle cx="6" cy="18" r="2.5"></circle><circle cx="18" cy="8" r="2.5"></circle><path d="M6 8.5v7M8 7c6 0 8 2 8 6v2.5"></path></svg></span> <span class="l-text svelte-gu3dqx">Git</span></button></div></div>`);
    }
    $$renderer2.push(`<!--]--></div></aside>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { sessionId });
  });
}
function filterSessions(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => (s.title ?? "").toLowerCase().includes(q) || (s.agent ?? "").toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
}
function CommandPalette($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let activeSessionId, agentList, filteredAgents, filteredSessions, filteredBackend, filteredStatic, flatItems, selectableCount;
    let open = fallback($$props["open"], false);
    const dispatch = createEventDispatcher();
    let query = "";
    let active = 0;
    let cmdError = "";
    let running = "";
    let about = null;
    let backendCommands = [];
    let loadedForBackend = null;
    function match(name, description, q) {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      return name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle);
    }
    const staticCommands = [
      { name: "new-session", description: "New session" },
      {
        name: "toggle-panel",
        description: "Collapse / expand the agent panel"
      },
      { name: "cycle-accent", description: "Cycle accent color" }
    ];
    function glyph(name) {
      const parts = name.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/[\s-]+/).filter(Boolean);
      return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || name.slice(0, 2).toUpperCase();
    }
    function buildItems(agents, sessions, backendCmds, staticCmds, sessionId) {
      const out = [];
      let idx = 0;
      if (agents.length) {
        out.push({ type: "group", label: "Agents", icon: "◆" });
        for (const a of agents) {
          out.push({ type: "agent", agent: a, selectableIndex: idx++ });
        }
      }
      if (sessions.length) {
        out.push({ type: "group", label: "Sessions", icon: "#" });
        for (const s of sessions) {
          out.push({ type: "session", session: s, selectableIndex: idx++ });
        }
      }
      const commands = [
        ...backendCmds.map((c) => ({ ...c, kind: "backend" })),
        ...staticCmds.map((c) => ({ ...c }))
      ];
      if (commands.length) {
        out.push({ type: "group", label: "Commands", icon: "/" });
        for (const c of commands) {
          const disabled = c.kind === "backend" && !sessionId;
          out.push({
            type: "command",
            command: c,
            disabled,
            selectableIndex: disabled ? void 0 : idx++
          });
        }
      }
      return out;
    }
    let returnFocus = null;
    function close() {
      dispatch("close");
      query = "";
      cmdError = "";
      returnFocus?.focus?.();
      returnFocus = null;
    }
    function commandHint(item, disabled) {
      if (disabled) return "Open a session first";
      return item?.description ?? "";
    }
    if (open && !about) {
      api.version().then((v) => {
        about = { version: v.version, uptime: v.uptime };
      }).catch(() => {
      });
    }
    activeSessionId = store_get($$store_subs ??= {}, "$page", page).params.sessionId;
    agentList = store_get($$store_subs ??= {}, "$backends", backends)?.backends ?? [];
    filteredAgents = agentList.filter((a) => match(a.name ?? a.id, a.id, query));
    filteredSessions = filterSessions(store_get($$store_subs ??= {}, "$sessionList", sessionList), query);
    if (open && store_get($$store_subs ??= {}, "$currentBackendId", currentBackendId) && store_get($$store_subs ??= {}, "$currentBackendId", currentBackendId) !== loadedForBackend) {
      loadedForBackend = store_get($$store_subs ??= {}, "$currentBackendId", currentBackendId);
      if (store_get($$store_subs ??= {}, "$can", can)("commands")) {
        api.commands(store_get($$store_subs ??= {}, "$currentBackendId", currentBackendId)).then((list) => {
          backendCommands = list;
        }).catch(() => {
          loadedForBackend = null;
        });
      } else {
        backendCommands = [];
      }
    }
    filteredBackend = backendCommands.filter((cmd) => match(cmd.name, cmd.description, query));
    filteredStatic = staticCommands.filter((cmd) => match(cmd.name, cmd.description, query));
    flatItems = buildItems(filteredAgents, filteredSessions, filteredBackend, filteredStatic, activeSessionId);
    selectableCount = flatItems.filter((i) => i.selectableIndex != null).length;
    active = selectableCount ? Math.max(0, Math.min(active, selectableCount - 1)) : -1;
    active = 0;
    if (
      /** 2-letter agent glyph from its name. */
      // Mounted when the palette opens: remember the trigger, take its place.
      /* optimistic; store reverts on failure */
      // Lightweight focus trap: Tab wraps between the first and last focusable row.
      open
    ) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="overlay svelte-wh9uu8"><button class="backdrop svelte-wh9uu8" aria-label="关闭"></button> <div class="palette svelte-wh9uu8" role="dialog" aria-modal="true" aria-label="搜索会话与命令" tabindex="-1"><div class="header svelte-wh9uu8"><span class="search-icon svelte-wh9uu8" aria-hidden="true">`);
      Icon($$renderer2, { name: "search", size: 14 });
      $$renderer2.push(`<!----></span> <input class="q svelte-wh9uu8" placeholder="跳转会话，或运行命令…" aria-label="搜索会话与命令"${attr("value", query)}/> <kbd class="keycap mono svelte-wh9uu8" aria-label="按 Esc 关闭">esc</kbd></div> <div class="results svelte-wh9uu8" role="listbox" aria-label="结果">`);
      if (flatItems.length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="empty svelte-wh9uu8">无匹配结果</div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<!--[-->`);
        const each_array = ensure_array_like(flatItems);
        for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
          let item = each_array[$$index];
          if (item.type === "group") {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`<div class="group svelte-wh9uu8" role="presentation"><span class="group-icon svelte-wh9uu8" aria-hidden="true">${escape_html(item.icon)}</span> <span class="group-label mono svelte-wh9uu8">${escape_html(item.label)}</span></div>`);
          } else if (item.type === "agent") {
            $$renderer2.push("<!--[1-->");
            $$renderer2.push(`<button${attr_class("row svelte-wh9uu8", void 0, { "active": item.selectableIndex === active })} role="option"${attr("aria-selected", item.selectableIndex === active)}><span class="tile glyph svelte-wh9uu8" aria-hidden="true">${escape_html(glyph(item.agent?.name ?? item.agent?.id ?? ""))}</span> <span class="label svelte-wh9uu8">${escape_html(item.agent?.name ?? item.agent?.id ?? "")}</span> <span class="hint mono svelte-wh9uu8">${escape_html(item.agent?.id === store_get($$store_subs ??= {}, "$backends", backends)?.activeId ? "active" : item.agent?.status ?? "")}</span></button>`);
          } else if (item.type === "session") {
            $$renderer2.push("<!--[2-->");
            $$renderer2.push(`<button${attr_class("row svelte-wh9uu8", void 0, { "active": item.selectableIndex === active })} role="option"${attr("aria-selected", item.selectableIndex === active)}><span class="tile svelte-wh9uu8" aria-hidden="true">#</span> <span class="label svelte-wh9uu8">${escape_html(item.session?.title ?? item.session?.id.slice(-8) ?? "")}</span> <span class="hint mono svelte-wh9uu8">${escape_html(item.session?.agent ?? "")}</span></button>`);
          } else if (item.type === "command") {
            $$renderer2.push("<!--[3-->");
            $$renderer2.push(`<button${attr_class("row svelte-wh9uu8", void 0, {
              "active": item.selectableIndex === active,
              "disabled": item.disabled
            })}${attr("disabled", item.disabled || running === item.command?.name, true)} role="option"${attr("aria-selected", item.selectableIndex === active)}><span class="tile svelte-wh9uu8" aria-hidden="true">/</span> <span class="label svelte-wh9uu8">${escape_html(item.command?.name ?? "")}</span> <span class="hint mono svelte-wh9uu8">${escape_html(running === item.command?.name ? "运行中…" : commandHint(item.command, item.disabled))}</span></button>`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]-->`);
        }
        $$renderer2.push(`<!--]-->`);
      }
      $$renderer2.push(`<!--]--> `);
      if (cmdError) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="error svelte-wh9uu8">${escape_html(cmdError)}</div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (about) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="about mono svelte-wh9uu8">ocrc v${escape_html(about.version)} · uptime ${escape_html(about.uptime)}</div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { open, close });
  });
}
function NewSessionModal($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let agents, defaultAgentId, selectedAgentName, agentRecents;
    let selectedAgentId = "";
    let directory = "";
    let creating = false;
    let showRecents = false;
    let dirSug = [];
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
    agents = store_get($$store_subs ??= {}, "$backends", backends)?.backends ?? [];
    defaultAgentId = store_get($$store_subs ??= {}, "$backends", backends)?.activeId ?? agents[0]?.id ?? "opencode";
    selectedAgentId = selectedAgentId || defaultAgentId;
    selectedAgentName = store_get($$store_subs ??= {}, "$backends", backends)?.backends.find((b) => b.id === selectedAgentId)?.name ?? selectedAgentId;
    agentRecents = (() => {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const s of [
        ...store_get($$store_subs ??= {}, "$sessionList", sessionList)
      ].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
        const mine = s.backendId === selectedAgentId || !s.backendId && selectedAgentId === "opencode";
        if (!mine || !s.directory || seen.has(s.directory)) continue;
        seen.add(s.directory);
        out.push({
          directory: s.directory,
          name: s.directory.replace(/\/+$/, "").split("/").pop() || s.directory
        });
      }
      return out;
    })();
    if (store_get($$store_subs ??= {}, "$newSessionOpen", newSessionOpen)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="overlay svelte-cfrpez"><button class="backdrop svelte-cfrpez" aria-label="关闭"></button> <div class="modal svelte-cfrpez" role="dialog" aria-modal="true" aria-label="新建会话"><div class="header svelte-cfrpez"><span class="title svelte-cfrpez">New session</span> <button class="close svelte-cfrpez" aria-label="关闭">`);
      Icon($$renderer2, { name: "close", size: 14 });
      $$renderer2.push(`<!----></button></div> <div class="body svelte-cfrpez">`);
      if (agents.length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="empty svelte-cfrpez">正在加载 agent… <button type="button" class="retry svelte-cfrpez">重新加载</button></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<div class="field svelte-cfrpez"><span class="label svelte-cfrpez">引擎 / 后端</span> <div class="agent-chips svelte-cfrpez" role="radiogroup" aria-label="选择 agent"><!--[-->`);
        const each_array = ensure_array_like(agents);
        for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
          let a = each_array[$$index];
          const theme = agentAccent(a.id);
          const selected = a.id === selectedAgentId;
          $$renderer2.push(`<button${attr_class("agent-chip svelte-cfrpez", void 0, { "selected": selected })} type="button" role="radio"${attr("aria-checked", selected)}><span class="chip-tile svelte-cfrpez"${attr_style(`background:${stringify(ACCENT_BG[theme])}; color:${stringify(ACCENT_HEX[theme])}; border-color:${stringify(ACCENT_LINE[theme])}`)}>`);
          if (a.id.startsWith("remote:")) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`☁`);
          } else {
            $$renderer2.push("<!--[-1-->");
            $$renderer2.push(`${escape_html(glyph(a))}`);
          }
          $$renderer2.push(`<!--]--></span> <span${attr_class(`chip-status ${stringify(statusClass(a.status))}`, "svelte-cfrpez")}${attr_style(`--dot:${stringify(ACCENT_HEX[theme])}`)}><span class="sr-only svelte-cfrpez">${escape_html(statusClass(a.status))}</span></span> <span class="chip-name svelte-cfrpez">${escape_html(a.id.startsWith("remote:") ? a.id.replace("remote:", "远程 · ") : a.name ?? a.id)}</span></button>`);
        }
        $$renderer2.push(`<!--]--> <button class="agent-chip remote-add svelte-cfrpez" type="button" aria-haspopup="dialog" title="连接远程主机（SSH / WSL / Docker）— 作为新建会话的下一级">＋ 远程连接</button></div></div>`);
      }
      $$renderer2.push(`<!--]--> <div class="field svelte-cfrpez"><label class="label svelte-cfrpez" for="new-session-dir">Working directory</label> <div class="dir-input svelte-cfrpez"><input id="new-session-dir" class="path mono svelte-cfrpez" type="text" placeholder="/path/to/project"${attr("value", directory)}/> <button class="browse svelte-cfrpez" type="button" title="逐级浏览目录">浏览</button> <button class="browse svelte-cfrpez" type="button" title="该 agent 最近使用的目录">最近</button></div> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (dirSug.length > 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="dir-sug svelte-cfrpez" role="listbox"><!--[-->`);
        const each_array_2 = ensure_array_like(dirSug);
        for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
          let sug = each_array_2[$$index_2];
          $$renderer2.push(`<button class="dir-sug-item svelte-cfrpez" type="button" role="option" aria-selected="false"${attr("title", sug.path)}><span class="recent-name svelte-cfrpez">${escape_html(sug.name)}</span> <span class="recent-dir mono svelte-cfrpez">${escape_html(sug.path)}</span></button>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (agentRecents.length > 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div${attr_class("recents svelte-cfrpez", void 0, { "open": showRecents })}><span class="recents-label mono svelte-cfrpez">recent · ${escape_html(selectedAgentName)}</span> <div class="recents-list svelte-cfrpez"><!--[-->`);
        const each_array_3 = ensure_array_like(agentRecents);
        for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
          let w = each_array_3[$$index_3];
          $$renderer2.push(`<button class="recent svelte-cfrpez" type="button"${attr("title", w.directory)}><span class="recent-name svelte-cfrpez">${escape_html(w.name)}</span> <span class="recent-dir mono svelte-cfrpez">${escape_html(w.directory)}</span></button>`);
        }
        $$renderer2.push(`<!--]--></div></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div> <div class="footer svelte-cfrpez"><button class="btn secondary svelte-cfrpez" type="button"${attr("disabled", creating, true)}>取消</button> <button class="btn primary svelte-cfrpez" type="button"${attr("disabled", !directory.trim(), true)}>${escape_html("Create")}</button></div></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
const larkPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABmJLR0QA/wD/AP+gvaeTAAAAB3RJTUUH6gkcFAMCstghUQAADE5JREFUeNrdm9lzW8eVxn/dd8MOggR3SqQWSyIlyrFlWbGVuOxxTWaqspQrVXnJU2r+wkzKqWSexk4yih3Hlmwp2mVtFPcVywXu2nnoC5HWYoEAKI5yqiCUQFzcPt855ztL3xZKKRIxgAwwABwETgCHks9fZYmBeeBy8qoDXvI5IgFAAOPA28C7wCRQBgrJ315lUYCbgPAP4G/AJWAJUCbawgeAD4CPgHOJ8q+65Z8UD23gaWAQ+DMwZ6Kt/GPg12jrpwC536vdA3HQhh5Eh7kB/MEEjqCtfw5I8+q7/PdJi+d+CKwByybwc2AWyO/36l6SiETXE8AHQin1OZr0hvd7ZS9ZloB7QilVRceHtdtfULu9oAPZw3gMAE8opaLkPru6V4wiVGrPQFBoJraE3CsQFEka3DXjK2AzCnkUNqnFMbFSPV+kAlJSMmGm6DcsLNFzGAQgzE6uDJViPvT4k7vBTc+lFkcoeuuuCkhLyWt2lvcyJaadLGnR++y8awAUEKFw44hHgcdnzS1u+S5bUUgvA0IBlhAMGw7rkY8tRzhuZXvuCbsGQACOkJxO5RkwLMatFL+rLvP3ZoWNHoMQKsVy5PPb6jIpIfmvvgnKpoXZQ1/rKAQEkBKSSSvNz3JlyobFWM3hU3eDR6GHr+KeLE4Bvoq57bt86m7wmpPh37Nl+mRHy+4dAI8vFoJJK01OmgwYFv2Gxf/U1/jWd2n0CASAhoq54tX4Y22VGSdHzs72zAt6AuWAYfFepsSY5WAKwR9rq9zyXZoq7llALEUef21s8XWzStmwGDacnvxuz2jVFpJDVobf9I3xUX6IY3YGu4c5PFKwFPp8XF3hpufSK//qaV5JC8kRK8MvC8P8qjDCjJ0l1cPUVY1DLjS2uOrVqURBTwi3d2ySiC0kJ+0cIq/T5X9Xl7np61qhWwmS+uOrZoU3UnneTBe6VqDnAIAmx2k7R6ogiZXi49oK1/w6jbh7TlAovmxWmG3kOJXKYQijqzDbEwBAFzGTVppfF0cxhSSuLnHFqxN0mR0ipbjh17ns1diKQhxDYnRRHD0TgCjxVqPLoZiTEONPc4N4KqYaR9wPGgSqcz9QQE1FzCmPW6FLWkmsALwgIgxjIqVAgRBgSIllShzbwLYMDONpoJ4CII5haRPCGAaLkLL0j3UqlhDMOFlq8QBLocfvaxGLobd7Fk/6VYlABYrFzQaf1VcJ/AaiFrNV83GbAUEQoZRCSq14Nm3Rl3col9L0Fx1syyCdMnEsAyGeAUAUw7WHsF6DmQMwNQIZp7tGxxGSk06Oj/JDLEU+F9wtViN/16YXkcIKQK2HLK9t8Umlyf2Khb/ps1H1qbsBfgKAYWgA8lmL/mKK8aEck2N5hgcyHJ8qMTqYxTTEdwFQaMvfmIeLd+DhKnz4Ohwdg2yXdUfJsHgrXWQ9CmnEMRcam7hJF9mW8s0Ycz3CWY5Q95rU7vl8tRDyjadQkSJWoJ4ILYFACJBSkHYMxgazvD07TC5jMTyQQT0JAIBS4AVa+fWa/n8QwYkJyKU6B0AA/dLig2yJpchjMwq42KwSvgiCGIz1EOOBj/Wth/EgQKyGqGqI14hpxPp6IcTToap01lAKanWwLYP+YopizsE0BILnkKAhIQhhbg3+75rmAKU0CNkUyA7jwRSCcTPFv2X6WQx9HoUeS6HP8/xABAq5GmJdb2Jdb2LM+Yi1CBEorawUGC9cjEApRSFnM324xLnTI4wPZZHJdc8EQAFCakJ8uAJ/vgp+qPnhxAQU0iA7LPAUMO3k+DDbz02/zp/qm2zGwbOVXwuxvmlgX3IxH/oIT2lX2mV2klJwaKLIf5w/yOvHyxRy9rZR2lnwo8QT6k2ouDA7CUPFztJkq5U+5eT4RW6IB0GTa16Et7M+iBRyJcT+poHzRR25FCB81RETSynoL6Q4e3KIn7w7+R3l2wIAIIx0avziFmy5sLoFZ4/B4REdLp3IsGFzPt3HNa9GNY6447uPlTfmA+zLDeyLrlbeU9vodQD4yaP9nJsdYaScwXxiwW0BIIUujla2wPWg1tDvQQgjJShkwNylN1hCctBK8Z+5Mg/CJmuRT6UZIJYC7G8a2F+7mHOBbgM75BwpBfmszZmZIU4fL2MZT3enbZfCLYatN+HqQ6g1dZZ44zDMHIShPjDl7oqmlJS8lS5w1e/jbt3lykoTcUlb3pxPlO9QFODYBq9N9nH6eJkDIzmEbKMSbAeIMIJ7S7BehfsrML8OZ47CkRFI2e2DIBHkhcmbMs+VNYdvv2wQf+Uil7tTXiOgKGQt3j87zrHJPhzr2S7acTMURrBRgyv3YasOi5vw5hENwmgJ0m0UTnGsqNR81m9UaXxewbpUJ1wOIOi+z0+nTA6O5Hl7doTRwexzv9cxAK00WHHh1jxs1mFxA05N6iwxOQT5NKSf4xFeELG46nLl5iqf/G2Om5eWUfN+95ZPgB0sZXjr1DBHDhTJZZ6/69d1O2xI7Q2LG9oj5tbg7iKcnITpCQ1ELq2/p8k0JggV9xcq/OXiAp9+McdXV1dYWnNRPdpdsSzJ0YNF3j87Tqlgf+9P9mQeIIQmHS+A+8s6W9xegOsT2htmDsLBQUhZMasbDS7fWuPCpUX++vUCN+9tUnUDYtVd17ltEMHUWJ6zJ4c4dXSAjPP9e749G4gIkmYq0mHR9BOPWIU7i3B0VJFzmty+84gvLz/gyu0V5ldcGk1dCMseaC8FpByLMyfHOHd6jFLBeeYMYE8AaIHQ0sMPYHkLKg1Y2IDrDyFjxdy963P/QcT6usD3JULECBWjlEIgOnMDpbtBJ+VweHKQc6cnmD48gNVGcbJnI7EWSfoBLKzDyiYYwqZaGSR0UmRKG5juKqFXJQqbqDgApZJJ7y7JQBhYts3QUIn33j7CD04M0V+028JyzwB4vDahXTNWglhZONkyTrpEFJQJcsPEgYvf2CBobhB6VQKvilLxtvri8T9PiAIlENLAdIqMjw/zozfG+Mk7wxwaS7ddme45AN/VQS8YaSANE8NOo1SElRkg9CqEXlW/ApcobBAFDeLQI458lIqSEJMIw8IwHaSVxU6VKBT7OTNb5qc/LjEz5ZDPtO89LwWA70grzQuJYTqaAA0H08mjIp849AgD9zEYUdjYDhEEUhpIw0FaGSynQL44wKnDOd4/k+LMMYtidnc08vIB2IlFq8kTBoZpgJUCBWYcEoeeBiQOUHGIStplPfkxkYZNJm0zNZriwzMG509CaZfKPxeAfXtQMAFEShNhG0AaoRRPPo6lEDiWYGpY8LOzgndOwGh/Zwnk2QAkxNXK7fshrZS4UymlIFbQn9eTqXdOwLvTMNYPVod7GE8BIAUUs7rHX6/qm/b++aQ2RSWPciWKmwaMleD0FPzwOLxxRDdeu51FPBcAgR5zTQ3Ba2MagHpTzwL3UwwJKRMGC3B+Gs7PaA/oy3Y+m3wmAK2bzRzQJa1jwsVvdUXnhy+fG1rPCpZyek3njmvrT5R1g9XpdHqnCKWe3qiLYl3H313UTc3le3Djke74Gn6ysA6r1hcprJSeRlsmDOTh2LhWfuYAHB6Fch6cLrfrXggA6JjzAz36ujEH/3gAd5f0hsnKVtLwJNNsIbaLnd2sS+2I8Vb4pW0oFzSxHRqG2SkdjsN9etrUC6u3BcBOcT0NxFpFA3H1IdxZ0JNiPwA/0l4Tx/r9RT+Y7GkgpSYwQ+pN2EJGK/r6IT1YmSjrOE87et64F9IWAC0WDiM9Ft+q69H4/IbeM7i3pMHYcjVxBhFPoyC23yxTK1XK6vw9VISJAT08KeW1m/flNChS9t7quwZgp8RKW7kVHpsJGBUXXF9/Vk9ezR0bwJax7cLZlH5lHK1oIa2JrpQD29Lf7XS/Yc8B2CkKDUYYQRwlXhJDw9MANPztctdOrC6EjnMnsa4htXsbsvuU1ikAHT0u/73AJEy+c765s7oUe5BBOlkmoLo6MNHOHR4DsN/qPi0B4En0Wbr1vbiDoMeu1VtZB65K4C/Awn6vZh/kAfAHCfwvcAOosn/N38sUBdSAK8DHJvB3tg8TvoM+OPmvdmq0JTHQBD4DPgFum+gDhJ8mf1xDHy8dTYD4V5IIWAU+B36LPjpbNYEQuJcgswxcBWaAMSDL/1sOa1sUUEmUvw9cQB+gfkSSBltflOh0mEWfJJ1NQHjVzxFHwF3gOpr41tCnySOAfwK44B4xUUtDyQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0yOFQyMDowMzowMiswMDowMJrHwKAAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMjhUMjA6MDM6MDIrMDA6MDDrmngcAAAAIHRFWHRzb2Z0d2FyZQBodHRwczovL2ltYWdlbWFnaWNrLm9yZ7zPHZ0AAAAYdEVYdFRodW1iOjpEb2N1bWVudDo6UGFnZXMAMaf/uy8AAAAXdEVYdFRodW1iOjpJbWFnZTo6SGVpZ2h0ADQ4h2CHLQAAABZ0RVh0VGh1bWI6OkltYWdlOjpXaWR0aAA0OH/PR6AAAAAZdEVYdFRodW1iOjpNaW1ldHlwZQBpbWFnZS9pY2+XMDjOAAAAF3RFWHRUaHVtYjo6TVRpbWUAMTc5MDYyNTc4MrLkzeUAAAASdEVYdFRodW1iOjpTaXplADk2NjJCQpTWNTIAAAAadEVYdFRodW1iOjpVUkkAZmlsZTovL2xhcmsuaWNvGFy81AAAAABJRU5ErkJggg==";
const dingtalkSvg = "data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%201024%201024'%20width='2500'%20height='2500'%3e%3cpath%20fill='%230089FF'%20d='M1024%20155.733C1024%2070.4%20953.6%200%20868.267%200H155.733C70.4%200%200%2070.4%200%20155.733v712.534C0%20953.6%2070.4%201024%20155.733%201024h712.534C953.6%201024%201024%20953.6%201024%20868.267V155.733z'/%3e%3cpath%20fill='%23FFF'%20d='M810.667%20422.4c-2.134%206.4-4.267%2014.933-8.534%2023.467C774.4%20505.6%20701.867%20620.8%20701.867%20620.8l-21.334%2036.267h102.4L588.8%20915.2l44.8-174.933h-78.933l27.733-115.2c-23.467%206.4-49.067%2012.8-81.067%2023.466%200%200-42.666%2025.6-121.6-46.933%200%200-53.333-46.933-23.466-59.733%2012.8-4.267%2064-10.667%20104.533-17.067%2055.467-6.4%2087.467-10.667%2087.467-10.667s-168.534%202.134-206.934-4.266c-40.533-6.4-89.6-72.534-100.266-132.267%200%200-17.067-32%2036.266-17.067s268.8%2059.734%20268.8%2059.734-281.6-87.467-300.8-108.8c-19.2-21.334-55.466-115.2-51.2-172.8%200%200%202.134-14.934%2017.067-10.667%200%200%20209.067%2096%20352%20147.2%20140.8%2053.333%20264.533%2081.067%20247.467%20147.2z'/%3e%3c/svg%3e";
function ChannelLogo($$renderer, $$props) {
  let channel = $$props["channel"];
  let size = fallback($$props["size"], 30);
  if (channel === "telegram") {
    $$renderer.push("<!--[0-->");
    $$renderer.push(`<svg${attr("width", size)}${attr("height", size)} viewBox="0 0 24 24" role="img" aria-label="Telegram"><path fill="#26A5E4" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"></path></svg>`);
  } else if (channel === "wechat") {
    $$renderer.push("<!--[1-->");
    $$renderer.push(`<svg${attr("width", size)}${attr("height", size)} viewBox="0 0 24 24" role="img" aria-label="WeChat"><path fill="#07C160" d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"></path></svg>`);
  } else if (channel === "dingtalk") {
    $$renderer.push("<!--[2-->");
    $$renderer.push(`<img${attr("src", dingtalkSvg)} alt="钉钉 / DingTalk"${attr("width", size)}${attr("height", size)}${attr_style(`border-radius: ${stringify(size * 0.18)}px`)}/>`);
  } else {
    $$renderer.push("<!--[-1-->");
    $$renderer.push(`<img${attr("src", larkPng)} alt="飞书 / Lark"${attr("width", size)}${attr("height", size)}${attr_style(`border-radius: ${stringify(size * 0.18)}px`)}/>`);
  }
  $$renderer.push(`<!--]-->`);
  bind_props($$props, { channel, size });
}
function ChannelsModal($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let selected, remaining, expired, countdown;
    let channels = [];
    let tgMeta = null;
    let selectedId;
    let pair = null;
    let tokenDraft = "";
    let proxyDraft = "";
    let allowDraft = "";
    let now = Date.now();
    let stopped = false;
    let countdownTimer;
    let pairedCount = null;
    let revokeArmed = false;
    async function load2() {
      try {
        const res = await api.channels();
        channels = res.channels ?? [];
        tgMeta = res.telegram ?? null;
        if (!selectedId && channels.length > 0) selectedId = channels[0].id;
      } catch {
      }
    }
    async function loadPair() {
      stopped = false;
      try {
        pair = await api.pairQr();
      } catch {
        pair = null;
      }
    }
    async function loadPairedCount() {
      try {
        pairedCount = (await api.pairOnboarding()).paired ?? null;
      } catch {
      }
    }
    onMount(() => {
      void load2();
      void loadPair();
      void loadPairedCount();
      countdownTimer = setInterval(() => now = Date.now(), 1e3);
    });
    onDestroy(() => {
      if (countdownTimer) clearInterval(countdownTimer);
    });
    function name(channel) {
      return channel === "telegram" ? "Telegram" : channel === "wechat" ? "企业微信" : channel === "lark" ? "飞书 / Lark" : channel === "dingtalk" ? "钉钉 / DingTalk" : channel;
    }
    const CREDENTIAL_FIELDS = {
      // telegram is rendered by its own dedicated block (token + Bot API proxy)
      // — not via this loop.
      telegram: [
        {
          key: "token",
          label: "BotFather token",
          placeholder: "BotFather token（留空保持不变）"
        }
      ],
      wechat: [
        { key: "corp_id", label: "企业 ID（corp_id）" },
        { key: "corp_secret", label: "应用 Secret（corp_secret）" },
        { key: "agent_id", label: "AgentId" },
        { key: "callback_token", label: "回调 Token" },
        { key: "encoding_aes_key", label: "回调 EncodingAESKey" }
      ],
      lark: [
        { key: "app_id", label: "App ID" },
        { key: "app_secret", label: "App Secret" }
      ],
      dingtalk: [
        { key: "client_id", label: "Client ID（AppKey）" },
        { key: "client_secret", label: "Client Secret（AppSecret）" }
      ]
    };
    let credDraft = {};
    function credFields(channel) {
      return CREDENTIAL_FIELDS[channel] ?? [];
    }
    selected = channels.find((c) => c.id === selectedId) ?? channels[0];
    remaining = pair?.expiresAt ? Math.max(0, pair.expiresAt - now) : null;
    expired = remaining !== null && remaining <= 0;
    countdown = remaining === null ? "" : `${Math.floor(remaining / 6e4)}:${String(Math.floor(remaining % 6e4 / 1e3)).padStart(2, "0")}`;
    if (store_get($$store_subs ??= {}, "$channelsOpen", channelsOpen)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="overlay svelte-b8emeh"><button class="backdrop svelte-b8emeh" aria-label="关闭"></button> <div class="modal svelte-b8emeh" role="dialog" aria-modal="true" aria-label="机器人与通道" tabindex="-1"><div class="header svelte-b8emeh"><span class="title svelte-b8emeh">🤖 机器人 · 通道</span> <button class="close svelte-b8emeh" aria-label="关闭">✕</button></div> <div class="cols svelte-b8emeh"><div class="list svelte-b8emeh"><!--[-->`);
      const each_array = ensure_array_like(channels);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let c = each_array[$$index];
        $$renderer2.push(`<button${attr_class("ch svelte-b8emeh", void 0, { "sel": selected?.id === c.id })}><span class="ch-logo svelte-b8emeh">`);
        ChannelLogo($$renderer2, { channel: c.channel, size: 22 });
        $$renderer2.push(`<!----></span> <span class="ch-name">${escape_html(name(c.channel))}</span> <span${attr_class("ch-state svelte-b8emeh", void 0, { "on": c.enabled })}>${escape_html(c.enabled ? "已启用" : "已停用")}</span></button>`);
      }
      $$renderer2.push(`<!--]--></div> `);
      if (selected) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="detail svelte-b8emeh"><div class="d-hd svelte-b8emeh"><span class="d-name svelte-b8emeh">${escape_html(name(selected.channel))}</span> <button${attr_class("switch svelte-b8emeh", void 0, { "on": selected.enabled })}${attr("aria-pressed", selected.enabled)} aria-label="启用通道"><span class="knob svelte-b8emeh"></span></button></div> <p class="note svelte-b8emeh">`);
        if (selected.channel === "telegram") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="n-line svelte-b8emeh">${escape_html(selected.live?.connected ? "轮询运行中" : "未在轮询")}${escape_html(selected.live?.username ? ` · @${selected.live.username}` : "")}；停用/启用在重启实例后生效。</span> <span class="n-line svelte-b8emeh">凭证来源：${escape_html(tgMeta?.tokenSource === "panel" ? `面板凭证${selected.hasToken && selected.tokenHint ? `（${selected.tokenHint}）` : ""}` : tgMeta?.tokenSource === "env" ? `config.env（TELEGRAM_BOT_TOKEN${tgMeta?.envTokenHint ? ` ${tgMeta.envTokenHint}` : ""}）` : "未配置")}</span> <span class="n-line svelte-b8emeh">Bot API 代理：${escape_html(tgMeta?.proxySource === "panel" ? "面板凭证" : tgMeta?.proxySource === "env" ? "环境变量" : "直连")}</span> <span class="n-line svelte-b8emeh">允许用户（生效）：${escape_html(tgMeta?.allowUsers ?? 0)} 个（来源：${escape_html(tgMeta?.allowSource === "panel" ? "面板" : "config.env")}）`);
          if ((tgMeta?.allowUsers ?? 0) === 0) {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`——bot 不会回复任何人`);
          } else {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`待接入：凭证保存后，通道本体在后续版本启用。`);
        }
        $$renderer2.push(`<!--]--></p> <div class="sec svelte-b8emeh"><div class="sec-label svelte-b8emeh">关联凭证`);
        if (selected.channel === "telegram") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`（保存时向 Telegram 验证）`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`（${escape_html(name(selected.channel))}接入前预置，保存到本地凭证库）`);
        }
        $$renderer2.push(`<!--]--></div> `);
        if (selected.channel === "telegram") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<input class="cred mono svelte-b8emeh" placeholder="BotFather token（留空保持不变）"${attr("value", tokenDraft)}/> <input class="cred mono svelte-b8emeh" placeholder="Bot API 代理 http://proxy:8080（留空 = TELEGRAM_PROXY env / 直连）"${attr("value", proxyDraft)}/> <div class="sec-acts svelte-b8emeh"><button class="save svelte-b8emeh">保存</button> `);
          {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--> `);
          {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<!--[-->`);
          const each_array_1 = ensure_array_like(credFields(selected.channel));
          for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
            let f = each_array_1[$$index_1];
            $$renderer2.push(`<label class="cred-row svelte-b8emeh"><span class="cred-label svelte-b8emeh">${escape_html(f.label)}</span> <input class="cred mono svelte-b8emeh" placeholder="待接入"${attr("value", credDraft[selected.id]?.[f.key] ?? "")}/></label>`);
          }
          $$renderer2.push(`<!--]--> <div class="sec-acts svelte-b8emeh"><button class="save svelte-b8emeh">保存</button> <span class="note svelte-b8emeh">保存整体替换该通道凭证；接入前仅落盘不入网</span> `);
          {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--> `);
          {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></div>`);
        }
        $$renderer2.push(`<!--]--></div> `);
        if (selected.channel === "telegram") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="sec svelte-b8emeh"><div class="sec-label svelte-b8emeh">允许用户`);
          if (tgMeta?.allowSource === "panel") {
            $$renderer2.push("<!--[0-->");
            $$renderer2.push(`（面板优先于 config.env）`);
          } else {
            $$renderer2.push("<!--[-1-->");
            $$renderer2.push(`（当前来自 config.env）`);
          }
          $$renderer2.push(`<!--]--></div> <input class="cred mono svelte-b8emeh" placeholder="逗号分隔的数字 user id，如 123456789, 987654321"${attr("value", allowDraft)}/> <div class="sec-acts svelte-b8emeh"><button class="save svelte-b8emeh">保存</button> <button class="save svelte-b8emeh" title="清空面板名单，恢复 config.env 的 ALLOWED_USER_IDS">恢复 env</button> `);
          {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--> `);
          {
            $$renderer2.push("<!--[-1-->");
          }
          $$renderer2.push(`<!--]--></div> <p class="note svelte-b8emeh">改动重启实例后生效。数字 id 通过 @userinfobot 等获取；空名单 = bot 不回复任何人。</p></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="sec svelte-b8emeh"><div class="sec-label svelte-b8emeh">回复粒度</div> <div class="opts svelte-b8emeh"><button${attr_class("opt svelte-b8emeh", void 0, { "sel": selected.replyGranularity === "standard" })}>标准回复（隐藏工具过程）</button> <button${attr_class("opt svelte-b8emeh", void 0, { "sel": selected.replyGranularity === "detailed" })}>详细回复（显示工具过程）</button></div></div> <div class="sec svelte-b8emeh"><div class="sec-label svelte-b8emeh">工作区访问范围</div> <div class="opts svelte-b8emeh"><button${attr_class("opt svelte-b8emeh", void 0, { "sel": selected.workspaces.mode === "all" })}>所有工作区</button> <button${attr_class("opt svelte-b8emeh", void 0, { "sel": selected.workspaces.mode === "custom" })}>自定义</button></div> `);
        if (selected.workspaces.mode === "custom") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<p class="hint svelte-b8emeh">自定义白名单已保存——用工作区切换器添加条目后再来这里勾选。</p>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div> <div class="sec danger svelte-b8emeh"><div class="sec-label svelte-b8emeh">重置</div> <button class="reset svelte-b8emeh">恢复默认设置</button></div></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div> <div class="pair svelte-b8emeh">`);
      if (pair && !stopped) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="pair-head svelte-b8emeh"><div><div class="pair-title svelte-b8emeh">等待手机连接 `);
        if (remaining !== null) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span${attr_class("cd mono svelte-b8emeh", void 0, { "expired": expired })}>${escape_html(expired ? "已过期" : `· ${countdown}`)}</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div> <div class="hint svelte-b8emeh">用手机扫码，或在手机上打开链接。链接 1 分钟内有效，仅可使用一次。</div></div> <button class="stop svelte-b8emeh">停止</button></div> <div${attr_class("qr-big svelte-b8emeh", void 0, { "dim": expired })}>${html(pair.svg)} `);
        if (expired) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="qr-expired svelte-b8emeh"><span>二维码已过期</span> <button class="copy svelte-b8emeh">刷新二维码</button></div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div> <div class="pair-acts svelte-b8emeh"><span class="hint svelte-b8emeh">无法扫码？可以在手机上打开链接。</span> <span class="spacer svelte-b8emeh"></span> <button class="copy svelte-b8emeh"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg> 刷新二维码</button> <button class="copy svelte-b8emeh">${escape_html("复制链接")}</button></div>`);
      } else if (stopped) {
        $$renderer2.push("<!--[1-->");
        $$renderer2.push(`<div class="pair-stopped svelte-b8emeh"><span>已停止配对。</span> <button class="copy svelte-b8emeh">重新开始</button></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
        $$renderer2.push(`<p class="hint svelte-b8emeh">配对信息加载中…</p>`);
      }
      $$renderer2.push(`<!--]--> <div class="pair-mgmt svelte-b8emeh"><span class="hint svelte-b8emeh">已配对 ${escape_html(pairedCount ?? "…")} 台设备</span> <span class="spacer svelte-b8emeh"></span> <button${attr_class("revoke svelte-b8emeh", void 0, { "armed": revokeArmed })}>${escape_html("撤销所有配对设备")}</button></div> `);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
function PlusMenu($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let anchor = fallback($$props["anchor"], null);
    if (store_get($$store_subs ??= {}, "$plusMenuOpen", plusMenuOpen)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="overlay svelte-1r7zhoh"><button class="backdrop svelte-1r7zhoh" aria-label="Close"></button> <div class="menu svelte-1r7zhoh" role="menu" aria-label="New actions"${attr_style(anchor ? `top:${anchor.getBoundingClientRect().bottom + 6}px; left:${anchor.getBoundingClientRect().left}px` : "")}><button class="item svelte-1r7zhoh" role="menuitem"><span class="icon svelte-1r7zhoh" aria-hidden="true">+</span> <span class="label svelte-1r7zhoh">New session</span></button> <button class="item svelte-1r7zhoh" role="menuitem"><span class="icon svelte-1r7zhoh" aria-hidden="true">`);
      Icon($$renderer2, { name: "search", size: 14 });
      $$renderer2.push(`<!----></span> <span class="label svelte-1r7zhoh">Command palette</span> <kbd class="keycap mono svelte-1r7zhoh">⌘K</kbd></button></div></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { anchor });
  });
}
function MobileFab($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let open = false;
    $$renderer2.push(`<div${attr_class("fab-root svelte-9zfapn", void 0, { "open": open })}>`);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <button${attr_class("fab svelte-9zfapn", void 0, { "rot": open })}${attr("aria-label", "快捷操作")}${attr("aria-expanded", open)}><span aria-hidden="true">＋</span></button></div>`);
  });
}
function PairGate($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let remaining, expired, pairedCount, hasPaired, countdown;
    let status = fallback($$props["status"], "pairing");
    let input = "";
    let showPaste = false;
    let onb = null;
    let now = Date.now();
    let timer;
    async function loadPair() {
      try {
        onb = await api.pairOnboarding();
        now = Date.now();
      } catch {
        onb = null;
      }
    }
    const CHANNEL_META = {
      telegram: { name: "Telegram", note: "从 Telegram 打开这台机器" },
      wechat: { name: "微信", note: "待接入（配置面板已预埋）" },
      lark: { name: "飞书 / Lark", note: "待接入（配置面板已预埋）" },
      dingtalk: { name: "钉钉 / DingTalk", note: "待接入（配置面板已预埋）" }
    };
    onMount(() => {
      void loadPair();
      timer = setInterval(
        () => {
          now = Date.now();
          if (expired) void loadPair();
        },
        1e3
      );
    });
    onDestroy(() => {
      if (timer) clearInterval(timer);
    });
    remaining = onb?.expiresAt ? Math.max(0, onb.expiresAt - now) : null;
    expired = remaining !== null && remaining <= 0;
    pairedCount = onb?.paired ?? 0;
    hasPaired = pairedCount > 0;
    countdown = remaining === null ? "" : `${Math.floor(remaining / 6e4)}:${String(Math.floor(remaining % 6e4 / 1e3)).padStart(2, "0")}`;
    $$renderer2.push(`<div class="gate svelte-9s687p"><div class="panel svelte-9s687p"><div class="head svelte-9s687p"><span class="hicon svelte-9s687p" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke-width="6" stroke-linecap="round" class="svelte-9s687p"><path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)" opacity=".85"></path><circle cx="49" cy="20" r="7" fill="var(--accent)" stroke="none"></circle></svg></span> <div><h1 class="svelte-9s687p">配对 ocrc 远程控制</h1> <p class="sub svelte-9s687p">扫码或在手机上打开链接，即可远程控制这台机器的 opencode。</p></div></div> `);
    if (store_get($$store_subs ??= {}, "$pairHint", pairHint)) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="rejected svelte-9s687p">${escape_html(store_get($$store_subs ??= {}, "$pairHint", pairHint))}</p>`);
    } else if (status === "rejected") {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<p class="rejected svelte-9s687p">上一次的令牌被服务器拒绝了——请在下方重新配对。</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <div class="cols svelte-9s687p"><section class="scan svelte-9s687p"><div class="sec-head svelte-9s687p"><span class="sec-title svelte-9s687p">📱 手机扫码连接</span> `);
    if (onb) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span class="chip mono svelte-9s687p">${escape_html(onb.host.hostname)} · ${escape_html(onb.host.arch)}</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div> <p class="sub svelte-9s687p">用手机相机扫码，在手机上打开这台机器。</p> `);
    if (onb) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="wait-row svelte-9s687p"><span${attr_class("wait svelte-9s687p", void 0, { "done": hasPaired })}>${escape_html(hasPaired ? `✓ 已有 ${pairedCount} 台设备完成配对` : "等待手机连接")} `);
      if (remaining !== null) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span${attr_class("mono cd svelte-9s687p", void 0, { "expired": expired })}>${escape_html(expired ? "二维码已过期" : `· ${countdown}`)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></span> <button class="btn enter svelte-9s687p">配对此浏览器并进入</button></div> <div class="qr-wrap svelte-9s687p">${html(onb.svg)} `);
      if (expired) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<div class="qr-re svelte-9s687p"><span>已过期</span> <button class="btn svelte-9s687p">刷新二维码</button></div>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></div> <div class="acts svelte-9s687p"><span class="hint svelte-9s687p">无法扫码？在手机上打开链接。</span> <span class="spacer svelte-9s687p"></span> <button class="btn svelte-9s687p">⟳ 刷新二维码</button> <button class="btn svelte-9s687p">${escape_html("复制链接")}</button></div> <p class="hint dim svelte-9s687p">二维码 1 分钟内有效、仅可使用一次；过期自动刷新，刷新会作废旧码。配对成功后本页自动进入面板。</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<p class="hint dim svelte-9s687p">配对信息加载中…（若宿主机未启用配对组件，请用下方令牌粘贴）</p>`);
    }
    $$renderer2.push(`<!--]--></section> <section class="channels svelte-9s687p"><div class="sec-head svelte-9s687p"><span class="sec-title svelte-9s687p">🤖 Bot 通道</span></div> <p class="sub svelte-9s687p">连接聊天 Bot，适合更长时间的移动端访问。</p> `);
    if (onb) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<!--[-->`);
      const each_array = ensure_array_like(onb.channels);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let ch = each_array[$$index];
        $$renderer2.push(`<div class="ch svelte-9s687p"><span class="ch-icon svelte-9s687p" aria-hidden="true">`);
        ChannelLogo($$renderer2, { channel: ch.channel, size: 30 });
        $$renderer2.push(`<!----></span> <div class="ch-body"><div class="ch-name svelte-9s687p">${escape_html(CHANNEL_META[ch.channel]?.name ?? ch.channel)} `);
        if (ch.channel === "telegram" && ch.live?.connected) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<span class="ok svelte-9s687p">已连接 @${escape_html(ch.live.username)}</span>`);
        } else if (ch.channel === "telegram") {
          $$renderer2.push("<!--[1-->");
          $$renderer2.push(`<span class="off svelte-9s687p">未连接</span>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<span class="off svelte-9s687p">待接入</span>`);
        }
        $$renderer2.push(`<!--]--></div> <div class="ch-note svelte-9s687p">${escape_html(CHANNEL_META[ch.channel]?.note ?? "")}</div></div> <span class="lock svelte-9s687p" title="配对后可配置">🔒</span></div>`);
      }
      $$renderer2.push(`<!--]--> <p class="hint dim svelte-9s687p">🔒 通道状态仅展示；凭证与回复粒度等配置在配对后的「机器人管理」面板（标题栏 🤖）中。</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<p class="hint dim svelte-9s687p">…</p>`);
    }
    $$renderer2.push(`<!--]--></section></div> <details class="paste svelte-9s687p"${attr("open", showPaste, true)}><summary class="svelte-9s687p">已有配对链接或令牌？</summary> <div class="paste-body svelte-9s687p"><input class="field mono svelte-9s687p"${attr("value", input)} placeholder="粘贴配对链接或令牌…" aria-label="配对令牌或链接" autocapitalize="off" autocorrect="off" spellcheck="false"/> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <button class="connect svelte-9s687p"${attr("disabled", !input.trim(), true)}>连接</button></div></details> <p class="hint dim foot svelte-9s687p">令牌只保存在本设备上 · Telegram 通道为可选，未配置时仅 Web 面板可用</p></div></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
    bind_props($$props, { status });
  });
}
function _layout($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let hasSession;
    let drawerLeft = false;
    let isMobile = false;
    let newButtonAnchor = null;
    function closeDrawers() {
      drawerLeft = false;
      inspectorOpen.set(false);
    }
    function toggleLeft() {
      drawerLeft = !drawerLeft;
      inspectorOpen.set(false);
    }
    function toggleRight() {
      inspectorOpen.update((v) => !v);
      drawerLeft = false;
    }
    let email = "";
    let wsClient = null;
    let uiBuild = "";
    const onResubscribe = (e) => {
      const d = e.detail;
      if (d?.sessionId) wsClient?.send({
        type: "subscribe",
        sessionId: d.sessionId,
        sinceSeq: d.sinceSeq ?? 0,
        epoch: get(feeds)[d.sessionId]?.epoch
      });
    };
    let railW = 264;
    let inspW = 380;
    let resizing = null;
    try {
      railW = Math.max(180, Math.min(520, Number(localStorage.getItem("ocrc.railW")) || 264));
      inspW = Math.max(280, Math.min(560, Number(localStorage.getItem("ocrc.inspW")) || 380));
    } catch {
    }
    let installEvent = null;
    async function install() {
      if (!installEvent) return;
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
    }
    let lastLoaded = null;
    let resyncInFlight = false;
    let lastResyncAt = 0;
    let gapTimer;
    async function resyncViaRest(id) {
      if (resyncInFlight || Date.now() - lastResyncAt < 2e3) return;
      resyncInFlight = true;
      lastResyncAt = Date.now();
      try {
        const { cards, lastSeq, busy } = await api.history(id);
        serverBusy.setKey(id, !!busy);
        feedResyncing.set(true);
        setHistory(id, cards, lastSeq);
        serverBusy.setKey(id, !!busy);
        setTimeout(() => feedResyncing.set(false), 350);
        wsClient?.send({
          type: "subscribe",
          sessionId: id,
          sinceSeq: lastSeq,
          epoch: get(feeds)[id]?.epoch
        });
      } catch (err) {
        console.warn("[layout] resync failed", err);
      } finally {
        resyncInFlight = false;
      }
    }
    function loadSession(id) {
      if (get(auth) !== "ready") return;
      viewedSessionId.set(id);
      setViewedSession(id);
      if (!id) {
        pruneFeeds(void 0);
        lastLoaded = null;
        return;
      }
      pruneFeeds(id);
      const feedEmpty = !get(feeds)[id]?.order?.length;
      if (id === lastLoaded && !feedEmpty) return;
      lastLoaded = id;
      sessionBooting.set(true);
      api.history(id).then(({ cards, lastSeq }) => {
        setHistory(id, cards, lastSeq);
        sessionBooting.set(false);
        wsClient?.send({
          type: "subscribe",
          sessionId: id,
          sinceSeq: lastSeq,
          epoch: get(feeds)[id]?.epoch
        });
      }).catch((err) => {
        console.warn("[layout] history failed", err);
        setHistory(id, [], 0);
        sessionBooting.set(false);
        wsClient?.send({ type: "subscribe", sessionId: id });
      });
    }
    function bootConnection() {
      if (wsClient) {
        wsClient.close();
        wsClient = null;
      }
      api.me().then((m) => {
        email = m.email;
      }).catch(() => {
      });
      api.version().then((v) => {
        uiBuild = v.commit || "";
      }).catch(() => {
      });
      setInterval(
        () => {
          navigator.serviceWorker?.getRegistration?.()?.then((r) => r?.update().catch(() => {
          }));
        },
        30 * 60 * 1e3
      );
      api.sessions().then((list) => {
        sessionList.set(list);
      }).catch(() => {
      });
      loadCapabilities();
      loadBackends();
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      setWsSend((msg) => wsClient?.send(msg));
      wsClient = createWsClient({
        url: `${protocol}//${location.host}/ws`,
        // On reconnect, re-subscribe with the feed's current lastSeq so the WS
        // replays only what we missed while disconnected.
        onReconnect: () => {
          if (lastLoaded) {
            const sinceSeq = get(feeds)[lastLoaded]?.lastSeq ?? 0;
            wsClient?.send({
              type: "subscribe",
              sessionId: lastLoaded,
              sinceSeq,
              epoch: get(feeds)[lastLoaded]?.epoch
            });
          }
        },
        onMessage: (msg) => {
          if (msg.type === "card" && msg.card) {
            const sid = msg.card.sessionId;
            const lastSeq = sid ? get(feeds)[sid]?.lastSeq ?? 0 : 0;
            if (Array.isArray(msg.cards)) upsertCards(msg.cards);
            else upsertCard(msg.card);
            if (sid && isSeqGap(lastSeq, msg.card)) {
              clearTimeout(gapTimer);
              gapTimer = setTimeout(
                () => {
                  void resyncViaRest(sid);
                },
                500
              );
            }
          } else if (msg.type === "cards" && Array.isArray(msg.cards)) {
            upsertCards(msg.cards);
          } else if (msg.type === "session.status" && typeof msg.sessionId === "string") {
            serverBusy.setKey(msg.sessionId, !!msg.busy);
          }
          if (msg.type === "sdelta" && msg.sessionId && msg.cardId) {
            applyStreamDelta(msg);
            if (msg.sessionId === get(viewedSessionId)) window.dispatchEvent(new CustomEvent("ocrc:stream-grew"));
          }
          if ((msg.type === "hello" || msg.type === "sessions") && msg.sessions) {
            sessionList.set(msg.sessions);
            noteSessionActivity(msg.sessions);
          }
          if (msg.type === "replayEnd" && typeof msg.sessionId === "string" && typeof msg.epoch === "string") {
            setFeedEpoch(msg.sessionId, msg.epoch);
          }
          if (msg.type === "replayEnd" && msg.complete === false && typeof msg.sessionId === "string") {
            void resyncViaRest(msg.sessionId);
          }
        }
      });
      loadSession(store_get($$store_subs ??= {}, "$page", page).params.sessionId);
    }
    onMount(() => {
      const unsubAuth = auth.subscribe((s) => {
        if (s === "ready") bootConnection();
      });
      if ("serviceWorker" in navigator) {
        let hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (hadController) location.reload();
          else hadController = true;
        });
      }
      const onBeforeInstall = (e) => {
        e.preventDefault();
        installEvent = e;
      };
      window.addEventListener("ocrc:resubscribe", onResubscribe);
      window.addEventListener("beforeinstallprompt", onBeforeInstall);
      window.addEventListener("ocrc:ws-reconnect", () => wsClient?.forceReconnect());
      const mq = window.matchMedia("(max-width: 820px)");
      isMobile = mq.matches;
      const onMq = (e) => {
        isMobile = e.matches;
        if (!e.matches) closeDrawers();
      };
      mq.addEventListener("change", onMq);
      const vv = window.visualViewport;
      const setKb = () => {
        return;
      };
      vv?.addEventListener("resize", setKb);
      vv?.addEventListener("scroll", setKb);
      const onOrient = () => setTimeout(setKb, 300);
      window.addEventListener("orientationchange", onOrient);
      let settleUntil = 0;
      let settleRAF = 0;
      const settleLoop = () => {
        if (Date.now() < settleUntil) settleRAF = requestAnimationFrame(settleLoop);
        else settleRAF = 0;
      };
      const startSettle = () => {
        settleUntil = Date.now() + 650;
        if (!settleRAF) settleRAF = requestAnimationFrame(settleLoop);
      };
      window.addEventListener("focusin", startSettle);
      window.addEventListener("focusout", startSettle);
      return () => {
        unsubAuth();
        window.removeEventListener("beforeinstallprompt", onBeforeInstall);
        window.removeEventListener("ocrc:resubscribe", onResubscribe);
        mq.removeEventListener("change", onMq);
        vv?.removeEventListener("resize", setKb);
        vv?.removeEventListener("scroll", setKb);
        window.removeEventListener("focusin", startSettle);
        window.removeEventListener("focusout", startSettle);
        window.removeEventListener("orientationchange", onOrient);
        if (settleRAF) cancelAnimationFrame(settleRAF);
        clearTimeout(gapTimer);
        wsClient?.close();
      };
    });
    afterNavigate((nav) => {
      closeDrawers();
      loadSession(nav.to?.params?.sessionId);
    });
    if (store_get($$store_subs ??= {}, "$backends", backends) && typeof document !== "undefined") {
      applyAgentTheme(store_get($$store_subs ??= {}, "$backends", backends).activeId);
    }
    hasSession = !!store_get($$store_subs ??= {}, "$page", page).params.sessionId;
    let $$settled = true;
    let $$inner_renderer;
    function $$render_inner($$renderer3) {
      $$renderer3.push(`<div class="app svelte-12qhfyh"${attr_style(`--rail-w:${stringify(railW)}px; --insp-w:${stringify(inspW)}px`)}>`);
      if (!(isMobile && hasSession)) {
        $$renderer3.push("<!--[0-->");
        Titlebar($$renderer3, {
          email,
          build: uiBuild,
          onPalette: () => paletteOpen.set(true),
          installEvent,
          onInstall: install,
          drawerLeft,
          drawerRight: store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen),
          onToggleLeft: toggleLeft,
          onToggleRight: toggleRight,
          get newButtonAnchor() {
            return newButtonAnchor;
          },
          set newButtonAnchor($$value) {
            newButtonAnchor = $$value;
            $$settled = false;
          }
        });
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> `);
      OfflineBanner($$renderer3);
      $$renderer3.push(`<!----> `);
      if (updated.current && true) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<div class="sw-update svelte-12qhfyh" role="status"><span>ocrc 已更新到新版本</span> <button class="svelte-12qhfyh">刷新页面</button> <button class="later svelte-12qhfyh">稍后</button></div>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> <div class="body svelte-12qhfyh">`);
      if (drawerLeft || store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen)) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<button class="backdrop svelte-12qhfyh" aria-label="Close"></button>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> <div${attr_class("rail-wrap svelte-12qhfyh", void 0, {
        "collapsed": !store_get($$store_subs ??= {}, "$leftPanelOpen", leftPanelOpen) && !isMobile,
        "open": drawerLeft || isMobile && !hasSession
      })}>`);
      AgentPanel($$renderer3, {
        activeId: store_get($$store_subs ??= {}, "$page", page).params.sessionId,
        drawer: isMobile,
        email,
        build: uiBuild
      });
      $$renderer3.push(`<!----></div> <div${attr_class("divider svelte-12qhfyh", void 0, { "resizing": resizing === "rail" })} role="separator" aria-orientation="vertical" aria-label="调整会话栏宽度（双击收起/展开）"></div> <main class="svelte-12qhfyh"><!--[-->`);
      slot($$renderer3, $$props, "default", {});
      $$renderer3.push(`<!--]--></main> `);
      if (store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen)) {
        $$renderer3.push("<!--[0-->");
        $$renderer3.push(`<div${attr_class("divider svelte-12qhfyh", void 0, { "resizing": resizing === "insp" })} role="separator" aria-orientation="vertical" aria-label="调整检查器宽度"></div>`);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> <div${attr_class("inspector-wrap svelte-12qhfyh", void 0, {
        "collapsed-insp": !store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen) && !isMobile,
        "open": store_get($$store_subs ??= {}, "$inspectorOpen", inspectorOpen)
      })}><div class="inspector-surface">`);
      Inspector($$renderer3, {
        sessionId: store_get($$store_subs ??= {}, "$page", page).params.sessionId
      });
      $$renderer3.push(`<!----></div></div></div></div> `);
      CommandPalette($$renderer3, {
        open: store_get($$store_subs ??= {}, "$paletteOpen", paletteOpen)
      });
      $$renderer3.push(`<!----> `);
      PlusMenu($$renderer3, { anchor: newButtonAnchor });
      $$renderer3.push(`<!----> `);
      NewSessionModal($$renderer3);
      $$renderer3.push(`<!----> `);
      ChannelsModal($$renderer3);
      $$renderer3.push(`<!----> `);
      if (!hasSession) {
        $$renderer3.push("<!--[0-->");
        MobileFab($$renderer3);
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]--> `);
      if (store_get($$store_subs ??= {}, "$auth", auth) !== "ready") {
        $$renderer3.push("<!--[0-->");
        PairGate($$renderer3, {
          status: store_get($$store_subs ??= {}, "$auth", auth) === "rejected" ? "rejected" : "pairing"
        });
      } else {
        $$renderer3.push("<!--[-1-->");
      }
      $$renderer3.push(`<!--]-->`);
    }
    do {
      $$settled = true;
      $$inner_renderer = $$renderer2.copy();
      $$render_inner($$inner_renderer);
    } while (!$$settled);
    $$renderer2.subsume($$inner_renderer);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
export {
  _layout as default
};
