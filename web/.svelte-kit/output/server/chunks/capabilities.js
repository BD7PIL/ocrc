import { x as writable, h as get, f as derived } from "./exports.js";
const STORAGE_KEY = "ocrc.token";
function readTokenFromHash(hash) {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h) return null;
  const t = new URLSearchParams(h).get("token");
  return t && t.trim() ? t.trim() : null;
}
function readPairPendingFromHash(hash) {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h) return null;
  const t = new URLSearchParams(h).get("pair");
  return t && t.trim() ? t.trim() : null;
}
function getToken() {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}
function setToken(token) {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
  }
}
function clearToken() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}
const AUTH_RELOAD_FLAG = "ocrc.authReloaded";
function handleAuthFailure(loc = window.location) {
  if (getToken()) {
    clearToken();
    try {
      const { pathname, search } = window.location;
      window.history.replaceState(null, "", pathname + search);
    } catch {
    }
    loc.reload();
    return;
  }
  try {
    if (sessionStorage.getItem(AUTH_RELOAD_FLAG)) return;
    sessionStorage.setItem(AUTH_RELOAD_FLAG, "1");
  } catch {
  }
  loc.reload();
}
function clearAuthReloadFlag() {
  try {
    sessionStorage.removeItem(AUTH_RELOAD_FLAG);
  } catch {
  }
}
const auth = writable("booting");
const pairHint = writable("");
let bootPairPending = null;
if (typeof location !== "undefined" && typeof window !== "undefined") {
  const early = readTokenFromHash(location.hash);
  if (early) setToken(early);
  bootPairPending = readPairPendingFromHash(location.hash);
  if (bootPairPending) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}
if (bootPairPending) {
  auth.set("booting");
  void (async () => {
    try {
      const res = await fetch("/api/pair/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pending: bootPairPending })
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!data.token) throw new Error("no token");
      setToken(data.token);
      pairHint.set("");
      auth.set("ready");
    } catch {
      pairHint.set("配对链接已失效（1 分钟过期或已被使用）——请在主机上刷新二维码后重试。");
      auth.set("pairing");
    }
  })();
} else {
  auth.set(getToken() ? "ready" : "pairing");
}
function onUnauthorized() {
  const stored = getToken();
  if (!stored) {
    if (get(auth) === "ready") handleAuthFailure();
    return;
  }
  const fragment = typeof location !== "undefined" ? readTokenFromHash(location.hash) : null;
  if (fragment && fragment !== stored) {
    setToken(fragment);
    void fetch("/api/me", { headers: { Authorization: `Bearer ${fragment}` } }).then((res) => {
      if (res.ok) {
        auth.set("ready");
        return;
      }
      clearToken();
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch {
      }
      auth.set("pairing");
    }).catch(() => {
    });
    return;
  }
  if (fragment) {
    auth.set("rejected");
    return;
  }
  clearToken();
  auth.set("pairing");
}
let base = "";
function authHeaders(extra) {
  const h = { ...extra ?? {} };
  const t = getToken();
  if (t) h["authorization"] = `Bearer ${t}`;
  return h;
}
const FETCH_TIMEOUT_MS = 2e4;
async function jsonGet(path) {
  const res = await fetch(`${base}${path}`, { credentials: "include", headers: authHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error(`GET ${path} 401`);
  }
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  clearAuthReloadFlag();
  return res.json();
}
async function jsonPost(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error(`POST ${path} 401`);
  }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`);
  clearAuthReloadFlag();
  return res.json();
}
async function jsonMethod(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: authHeaders(body === void 0 ? void 0 : { "content-type": "application/json" }),
    credentials: "include",
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new Error(`${method} ${path} 401`);
  }
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}`);
  clearAuthReloadFlag();
  return res.json();
}
async function jsonPatch(path, body) {
  return jsonMethod("PATCH", path, body);
}
async function jsonDelete(path) {
  return jsonMethod("DELETE", path);
}
const api = {
  me: () => jsonGet("/api/me"),
  capabilities: () => jsonGet("/api/capabilities"),
  backends: () => jsonGet("/api/backends"),
  setActiveBackend: (backendId) => jsonPost("/api/backends/active", { backendId }),
  sessions: () => jsonGet("/api/sessions"),
  cleanupSubagents: () => jsonPost("/api/sessions/cleanup-subagents", {}),
  /** Revert the last exchange / undo a revert (opencode session.revert). */
  revertSession: (id, messageId) => jsonPost(`/api/session/${id}/revert?messageID=${encodeURIComponent(messageId)}`, {}),
  unrevertSession: (id) => jsonPost(`/api/session/${id}/unrevert`, {}),
  revertState: (id) => jsonGet(`/api/session/${id}/revert-state`),
  deleteSession: (id) => jsonPost(`/api/sessions/${id}/delete`, {}),
  renameSession: (id, title) => jsonPost(`/api/sessions/${id}/rename`, { title }),
  history: (id, opts) => {
    const q = new URLSearchParams();
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    if (opts?.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return jsonGet(`/api/session/${id}${qs ? `?${qs}` : ""}`);
  },
  todo: (id) => jsonGet(`/api/session/${id}/todo`),
  context: (id) => jsonGet(`/api/session/${id}/context`),
  workspaces: () => jsonGet("/api/workspaces"),
  createSession: (body) => jsonPost("/api/session", body),
  mcp: () => jsonGet("/api/mcp"),
  commands: (backendId) => jsonGet(`/api/commands${backendId ? `?backend=${encodeURIComponent(backendId)}` : ""}`),
  runCommand: (body) => jsonPost("/api/command", body),
  agents: () => jsonGet("/api/agents"),
  models: () => jsonGet("/api/models"),
  getOverrides: () => jsonGet("/api/overrides"),
  setOverrides: (body) => jsonPost("/api/overrides", body),
  sendMessage: (body) => jsonPost("/api/message", body),
  abort: (sessionId) => jsonPost("/api/abort", { sessionId }),
  suggestions: (sessionId) => jsonGet(`/api/session/${sessionId}/suggestions`),
  approve: (sessionId, requestId, decision) => jsonPost("/api/approval", { sessionId, requestId, decision }),
  answerQuestion: (sessionId, requestId, answers) => jsonPost("/api/question/reply", { sessionId, requestId, answers }),
  rejectQuestion: (sessionId, requestId) => jsonPost("/api/question/reject", { sessionId, requestId }),
  controls: (id) => jsonGet(`/api/session/${id}/controls`),
  setMode: (id, modeId) => jsonPost(`/api/session/${id}/mode`, { modeId }),
  setModel: (id, modelId) => jsonPost(`/api/session/${id}/model`, { modelId }),
  files: (id, q) => jsonGet(`/api/session/${id}/files?q=${encodeURIComponent(q)}`),
  schedules: () => jsonGet("/api/schedules"),
  remotes: () => jsonGet("/api/remotes"),
  saveRemote: (body) => jsonPost("/api/remotes", body),
  setRemoteEnabled: (id, enabled) => jsonPatch(`/api/remotes/${id}`, { enabled }),
  deleteRemote: (id) => jsonPost(`/api/remotes/${id}/delete`, {}),
  inspectRemote: (id) => jsonPost(`/api/remotes/${id}/inspect`, {}),
  provisionRemote: (id) => jsonPost(`/api/remotes/${id}/provision`, {}),
  syncRemoteAuth: (id) => jsonPost(`/api/remotes/${id}/sync-auth`, {}),
  syncRemoteConfig: (id) => jsonPost(`/api/remotes/${id}/sync-config`, {}),
  subagents: (id) => jsonGet(`/api/session/${id}/subagents`),
  /** Raw server message — tool parts carry state.output (tool output pages). */
  messageRaw: (id, messageId) => jsonGet(`/api/session/${id}/message/${encodeURIComponent(messageId)}`),
  /** Git pane: branch + per-file working-tree status. */
  vcs: (sessionId) => jsonGet(`/api/vcs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  /** Git pane: one file's working-tree patch (lazy per file). */
  vcsDiff: (sessionId, file) => jsonGet(`/api/vcs/diff?file=${encodeURIComponent(file)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  version: () => jsonGet("/api/version"),
  skills: (directory) => jsonGet(`/api/skills${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`),
  browse: (directory, path) => jsonGet(`/api/browse?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`),
  fileContent: (directory, path) => jsonGet(`/api/file-content?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`),
  worktrees: (directory) => jsonGet(`/api/worktrees${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`),
  createWorktree: (directory, name) => jsonPost("/api/worktrees", { directory, name }),
  removeWorktree: (directory, name) => jsonDelete(`/api/worktrees?directory=${encodeURIComponent(directory)}&name=${encodeURIComponent(name)}`),
  channels: () => jsonGet("/api/channels"),
  updateChannel: (id, patch) => jsonPatch(`/api/channels/${id}`, patch),
  resetChannel: (id) => jsonPost(`/api/channels/${id}/reset`, {}),
  pairQr: () => jsonGet("/api/pair/qr"),
  pairReset: () => jsonPost("/api/pair/reset", {}),
  pairOnboarding: () => jsonGet("/api/pair/onboarding"),
  exchangePair: (pending) => jsonPost("/api/pair/exchange", { pending }),
  addSchedule: (body) => jsonPost("/api/schedules", body),
  setScheduleEnabled: (id, enabled) => jsonPatch(`/api/schedules/${id}`, { enabled }),
  deleteSchedule: (id) => jsonDelete(`/api/schedules/${id}`),
  runSchedule: (id) => jsonPost(`/api/schedules/${id}/run`, {})
};
const sessionList = writable([]);
const emptyFeed = () => ({ order: [], byId: {}, lastSeq: 0 });
function setFeedEpoch(id, epoch) {
  feeds.update((m) => {
    const f = m[id];
    if (!f || f.epoch === epoch) return m;
    m[id] = { ...f, epoch };
    return m;
  });
}
const serverBusy = (() => {
  const map = writable({});
  return {
    subscribe: map.subscribe,
    setKey(id, v) {
      map.update((m) => ({ ...m, [id]: v }));
    },
    clearKey(id) {
      map.update((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      });
    }
  };
})();
const feeds = writable({});
function cardId(card, fallbackIndex) {
  return card.id ?? `${card.kind}:${card.seq ?? fallbackIndex}`;
}
function isTransient(kind) {
  return kind === "thinking" || kind === "think-stream";
}
function isRunningCard(kind) {
  return kind === "thinking" || kind === "streaming" || kind === "think-stream";
}
function cardsOf(feed) {
  if (!feed) return [];
  return feed.order.map((id) => feed.byId[id]).filter(Boolean);
}
function isSeqGap(lastSeq, card) {
  return typeof card.seq === "number" && lastSeq > 0 && card.seq > lastSeq + 1;
}
function upsertCard(card) {
  if (!("sessionId" in card) || !card.sessionId) return;
  const sid = card.sessionId;
  const id = cardId(card, 0);
  clearPendingDeltas(id);
  feeds.update((map) => {
    const feed = map[sid] ?? emptyFeed();
    if (card.seq != null && card.seq <= feed.lastSeq && !(id in feed.byId)) return map;
    if (card.seq != null) feed.lastSeq = Math.max(feed.lastSeq, card.seq);
    const stamped = card.id ? card : { ...card, id };
    if (card.kind === "status") {
      const lastId = feed.order[feed.order.length - 1];
      const last = lastId ? feed.byId[lastId] : void 0;
      if (last?.kind === "status" && JSON.stringify(last.fields) === JSON.stringify(card.fields)) {
        feed.byId = { ...feed.byId, [lastId]: stamped };
        return map;
      }
    }
    if (id in feed.byId) {
      feed.byId = { ...feed.byId, [id]: stamped };
    } else {
      let order = feed.order;
      let byId = feed.byId;
      if (card.kind === "streaming" || card.kind === "assistant" || card.kind === "error") {
        byId = { ...byId };
        order = order.filter((x) => {
          if (isTransient(byId[x]?.kind)) {
            delete byId[x];
            return false;
          }
          if (card.kind === "error" && byId[x]?.kind === "streaming" && x !== id) {
            delete byId[x];
            return false;
          }
          return true;
        });
      }
      feed.order = [...order, id];
      feed.byId = { ...byId, [id]: stamped };
    }
    return { ...map, [sid]: feed };
  });
}
function upsertCards(cards) {
  if (cards.length === 0) return;
  feeds.update((map) => {
    let next = map;
    for (const card of cards) {
      if (!("sessionId" in card) || !card.sessionId) continue;
      const sid = card.sessionId;
      const feed = next[sid] ?? emptyFeed();
      const id = cardId(card, 0);
      if (card.seq != null) feed.lastSeq = Math.max(feed.lastSeq, card.seq);
      const stamped = card.id ? card : { ...card, id };
      if (id in feed.byId) {
        feed.byId = { ...feed.byId, [id]: stamped };
      } else {
        let order = feed.order;
        let byId = feed.byId;
        if (card.kind === "streaming" || card.kind === "assistant" || card.kind === "error") {
          byId = { ...byId };
          order = order.filter((x) => {
            const k = byId[x]?.kind;
            if (isTransient(k)) {
              delete byId[x];
              return false;
            }
            if (card.kind === "error" && k === "streaming" && x !== id) {
              delete byId[x];
              return false;
            }
            return true;
          });
        }
        feed.order = [...order, id];
        feed.byId = { ...byId, [id]: stamped };
      }
      next = { ...next, [sid]: feed };
    }
    return next;
  });
}
function removeCard(id) {
  feeds.update((map) => {
    for (const sid of Object.keys(map)) {
      const feed = map[sid];
      if (!(id in feed.byId)) continue;
      const byId = { ...feed.byId };
      delete byId[id];
      return { ...map, [sid]: { ...feed, order: feed.order.filter((x) => x !== id), byId } };
    }
    return map;
  });
}
const pendingDeltas = /* @__PURE__ */ new Map();
let deltaFlushTimer;
function applyStreamDelta(frame) {
  if (!frame.text || !frame.cardId || !frame.sessionId) return;
  const key = `${frame.sessionId}\0${frame.cardId}`;
  let parts = pendingDeltas.get(key);
  if (!parts) {
    parts = /* @__PURE__ */ new Map();
    pendingDeltas.set(key, parts);
  }
  parts.set(frame.partId, (parts.get(frame.partId) ?? "") + frame.text);
  if (deltaFlushTimer) return;
  deltaFlushTimer = setTimeout(flushStreamDeltas, 45);
}
function flushStreamDeltas() {
  deltaFlushTimer = void 0;
  if (pendingDeltas.size === 0) return;
  const batches = [...pendingDeltas.entries()];
  pendingDeltas.clear();
  feeds.update((map) => {
    let next = map;
    for (const [key, parts] of batches) {
      const sep = key.indexOf("\0");
      const feed = next[key.slice(0, sep)];
      const cardId2 = key.slice(sep + 1);
      const card = feed?.byId[cardId2];
      if (!feed || card?.kind !== "streaming") continue;
      const blocks = [...card.blocks];
      let changed = false;
      for (const [partId, text] of parts) {
        const i = blocks.findIndex((b) => b.type !== "tool" && b.partId === partId);
        if (i >= 0 && (blocks[i].type === "text" || blocks[i].type === "reasoning")) {
          blocks[i] = { ...blocks[i], text: blocks[i].text + text };
          changed = true;
        } else if (i < 0) {
          blocks.push({ type: "text", text, partId });
          changed = true;
        }
      }
      if (!changed) continue;
      next = { ...next, [key.slice(0, sep)]: { ...feed, byId: { ...feed.byId, [cardId2]: { ...card, blocks } } } };
    }
    return next;
  });
}
function clearPendingDeltas(cardId2) {
  for (const key of pendingDeltas.keys()) {
    if (key.endsWith(`\0${cardId2}`)) pendingDeltas.delete(key);
  }
}
function setHistory(sessionId, cards, lastSeq = 0) {
  feeds.update((map) => {
    const feed = emptyFeed();
    feed.lastSeq = lastSeq;
    cards.forEach((c, i) => {
      const id = cardId(c, i);
      feed.order.push(id);
      feed.byId[id] = c.id ? c : { ...c, id };
    });
    return { ...map, [sessionId]: feed };
  });
}
let prependPage = 0;
function prependHistory(sessionId, cards) {
  if (cards.length === 0) return;
  prependPage += 1;
  const page = prependPage;
  feeds.update((map) => {
    const feed = map[sessionId] ?? emptyFeed();
    const byId = { ...feed.byId };
    const head = [];
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      const id = c.id ?? `${c.kind}:h${page}:${i}`;
      if (id in byId) continue;
      head.push(id);
      byId[id] = c.id ? c : { ...c, id };
    }
    if (head.length === 0) return map;
    return { ...map, [sessionId]: { order: [...head.reverse(), ...feed.order], byId, lastSeq: feed.lastSeq } };
  });
}
function pruneFeeds(keep) {
  const keepSet = new Set(Array.isArray(keep) ? keep : keep ? [keep] : []);
  feeds.update((map) => {
    const next = {};
    for (const sid of Object.keys(map)) {
      if (keepSet.has(sid)) next[sid] = map[sid];
    }
    return next;
  });
}
const sessions = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  applyStreamDelta,
  cardsOf,
  feeds,
  isRunningCard,
  isSeqGap,
  prependHistory,
  pruneFeeds,
  removeCard,
  serverBusy,
  sessionList,
  setFeedEpoch,
  setHistory,
  upsertCard,
  upsertCards
}, Symbol.toStringTag, { value: "Module" }));
const capabilities = writable(null);
const backends = writable(null);
const viewedSessionId = writable(void 0);
const currentCaps = derived(
  [backends, viewedSessionId, sessionList, capabilities],
  ([$backends, $sid, $list, $caps]) => {
    if ($backends) {
      const row = $sid ? $list.find((s) => s.id === $sid) : void 0;
      const id = row?.backendId ?? $backends.activeId;
      const found = $backends.backends.find((b) => b.id === id);
      if (found) return found.capabilities;
    }
    return $caps?.capabilities ?? null;
  }
);
const currentBackendId = derived(
  [backends, viewedSessionId, sessionList, capabilities],
  ([$backends, $sid, $list, $caps]) => {
    if ($backends) {
      const row = $sid ? $list.find((s) => s.id === $sid) : void 0;
      return row?.backendId ?? $backends.activeId;
    }
    return $caps?.id ?? null;
  }
);
const can = derived(currentCaps, ($caps) => (feature) => {
  if (!$caps) return true;
  return $caps[feature] !== false;
});
const activeCaps = derived([backends, capabilities], ([$backends, $caps]) => {
  if ($backends) return $backends.backends.find((b) => b.id === $backends.activeId)?.capabilities ?? null;
  return $caps?.capabilities ?? null;
});
derived(activeCaps, ($caps) => (feature) => {
  if (!$caps) return true;
  return $caps[feature] !== false;
});
const backendName = derived(currentBackendId, ($id) => {
  const id = $id ?? "opencode";
  return id.includes(":") ? id.split(":").pop() : id;
});
const ACCENTS = ["emerald", "azure", "amber", "violet"];
const ACCENT_HEX = {
  emerald: "#54d398",
  azure: "#5b9eff",
  amber: "#ffc34d",
  violet: "#b48cf0"
};
const ACCENT_BG = {
  emerald: "#0f261b",
  azure: "#101f33",
  amber: "#2a2110",
  violet: "#1d1733"
};
const ACCENT_LINE = {
  emerald: "#236b49",
  azure: "#2c5891",
  amber: "#8a6a26",
  violet: "#5a4790"
};
const AGENT_ACCENT_KEY = "ocrc.agentAccents";
const DEFAULT_AGENT_ACCENT = {
  opencode: "emerald",
  "acp:kimi": "azure"
};
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = h * 31 + s.charCodeAt(i) >>> 0;
  }
  return h;
}
function defaultAccentForAgent(id) {
  if (DEFAULT_AGENT_ACCENT[id]) return DEFAULT_AGENT_ACCENT[id];
  return ACCENTS[hashString(id) % ACCENTS.length];
}
function loadAgentAccentOverrides() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(AGENT_ACCENT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
const accentOverrides = writable(loadAgentAccentOverrides());
function agentAccent(id) {
  const overrides = get(accentOverrides);
  return ACCENTS.includes(overrides[id]) ? overrides[id] : defaultAccentForAgent(id);
}
function applyAgentTheme(agentId) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-accent", agentAccent(agentId));
}
async function loadCapabilities() {
  try {
    capabilities.set(await api.capabilities());
  } catch (err) {
    console.warn("[capabilities] failed to load", err);
  }
}
async function loadBackends() {
  try {
    backends.set(await api.backends());
  } catch (err) {
    console.warn("[backends] failed to load", err);
  }
}
export {
  ACCENT_BG as A,
  upsertCard as B,
  upsertCards as C,
  viewedSessionId as D,
  ACCENT_HEX as a,
  ACCENT_LINE as b,
  accentOverrides as c,
  agentAccent as d,
  api as e,
  applyAgentTheme as f,
  applyStreamDelta as g,
  auth as h,
  backendName as i,
  backends as j,
  can as k,
  cardsOf as l,
  currentBackendId as m,
  feeds as n,
  getToken as o,
  handleAuthFailure as p,
  isSeqGap as q,
  loadBackends as r,
  loadCapabilities as s,
  pairHint as t,
  pruneFeeds as u,
  serverBusy as v,
  sessionList as w,
  sessions as x,
  setFeedEpoch as y,
  setHistory as z
};
