import { b as onMount$1, t as tick, k as svelte, i as settled } from "./index-client.js";
import { SvelteKitError, Redirect, HttpError } from "@sveltejs/kit/internal";
import { k as hash, x as writable, d as decode_params, e as decode_pathname, a as add_data_suffix, m as make_trackable, n as noop_span, l as normalize_path, c as compact } from "./exports.js";
import { b as base64_decode, n as noop, f as get_status, g as get_message, T as TRAILING_SLASH_PARAM, I as INVALIDATED_PARAM, d as create_remote_key } from "./shared.js";
import "clsx";
import { ag as version } from "./environment.js";
import * as devalue from "devalue";
const native_fetch = window.fetch;
{
  window.fetch = (input, init) => {
    const method = input instanceof Request ? input.method : init?.method || "GET";
    if (method !== "GET") {
      cache.delete(build_selector(input));
    }
    return native_fetch(input, init);
  };
}
const cache = /* @__PURE__ */ new Map();
function initial_fetch(resource, opts) {
  const selector = build_selector(resource, opts);
  const script = document.querySelector(selector);
  if (script?.textContent) {
    script.remove();
    let { body, ...init } = JSON.parse(script.textContent);
    const ttl = script.getAttribute("data-ttl");
    if (ttl) cache.set(selector, { body, init, ttl: 1e3 * Number(ttl) });
    const b64 = script.getAttribute("data-b64");
    if (b64 !== null) {
      body = base64_decode(body);
    }
    return Promise.resolve(new Response(body, init));
  }
  return window.fetch(resource, opts);
}
function subsequent_fetch(resource, resolved, opts) {
  if (cache.size > 0) {
    const selector = build_selector(resource, opts);
    const cached = cache.get(selector);
    if (cached) {
      if (performance.now() < cached.ttl && ["default", "force-cache", "only-if-cached", void 0].includes(opts?.cache)) {
        return new Response(cached.body, cached.init);
      }
      cache.delete(selector);
    }
  }
  return window.fetch(resolved, opts);
}
function build_selector(resource, opts) {
  const url = JSON.stringify(resource instanceof Request ? resource.url : resource);
  let selector = `script[data-sveltekit-fetched][data-url=${url}]`;
  if (opts?.headers || opts?.body) {
    const values = [];
    if (opts.headers) {
      values.push([...new Headers(opts.headers)].join(","));
    }
    if (opts.body && (typeof opts.body === "string" || ArrayBuffer.isView(opts.body))) {
      values.push(opts.body);
    }
    selector += `[data-hash="${hash(...values)}"]`;
  }
  return selector;
}
// @__NO_SIDE_EFFECTS__
function get(key, parse = JSON.parse) {
  try {
    return parse(sessionStorage[key]);
  } catch {
  }
}
var define_SVELTEKIT_PAYLOAD_default = {};
const base = define_SVELTEKIT_PAYLOAD_default?.base ?? "";
const assets = define_SVELTEKIT_PAYLOAD_default?.assets ?? base ?? "";
const SNAPSHOT_KEY = "sveltekit:snapshot";
const SCROLL_KEY = "sveltekit:scroll";
const STATES_KEY = "sveltekit:states";
const HISTORY_INDEX = "sveltekit:history";
const NAVIGATION_INDEX = "sveltekit:navigation";
const origin = location.origin;
function resolve_url(url) {
  if (url instanceof URL) return url;
  let baseURI = document.baseURI;
  if (!baseURI) {
    const baseTags = document.getElementsByTagName("base");
    baseURI = baseTags.length ? baseTags[0].href : document.URL;
  }
  return new URL(url, baseURI);
}
function scroll_state() {
  return {
    x: pageXOffset,
    y: pageYOffset
  };
}
function notifiable_store(value) {
  const store = writable(value);
  let ready = true;
  function notify() {
    ready = true;
    store.update((val) => val);
  }
  function set(new_value) {
    ready = false;
    store.set(new_value);
  }
  function subscribe(run) {
    let old_value;
    return store.subscribe((new_value) => {
      if (old_value === void 0 || ready && new_value !== old_value) {
        run(old_value = new_value);
      }
    });
  }
  return { notify, set, subscribe };
}
const updated_listener = {
  v: noop
};
function create_updated_store() {
  const { set, subscribe } = writable(false);
  let timeout;
  async function check() {
    clearTimeout(timeout);
    try {
      const res = await fetch(`${assets}/${"_app/version.json"}`, {
        headers: {
          pragma: "no-cache",
          "cache-control": "no-cache"
        }
      });
      if (!res.ok) {
        return false;
      }
      const data = await res.json();
      const updated2 = data.version !== version;
      if (updated2) {
        set(true);
        updated_listener.v();
        clearTimeout(timeout);
      }
      return updated2;
    } catch {
      return false;
    }
  }
  return {
    subscribe,
    check
  };
}
function is_external_url(url, base2, hash_routing) {
  if (url.origin !== origin || !url.pathname.startsWith(base2)) {
    return true;
  }
  if (hash_routing) {
    return url.pathname !== location.pathname;
  }
  return false;
}
let page;
let navigating;
let updated;
const is_legacy = onMount$1.toString().includes("$$") || /function \w+\(\) \{\}/.test(onMount$1.toString());
const placeholder_url = "a:";
if (is_legacy) {
  page = {
    data: {},
    form: null,
    error: null,
    params: {},
    route: { id: null },
    state: {},
    status: -1,
    url: new URL(placeholder_url)
  };
  navigating = { current: null };
  updated = { current: false };
} else {
  page = new class Page {
    data = {};
    form = null;
    error = null;
    params = {};
    route = { id: null };
    state = {};
    status = -1;
    url = new URL(placeholder_url);
  }();
  navigating = new class Navigating {
    current = null;
  }();
  updated = new class Updated {
    current = false;
  }();
  updated_listener.v = () => updated.current = true;
}
function update(new_page) {
  Object.assign(page, new_page);
}
async function* read_ndjson(reader) {
  let done = false;
  let buffer = "";
  const decoder = new TextDecoder();
  while (true) {
    let split = buffer.indexOf("\n");
    while (split !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (line) {
        yield JSON.parse(line);
      }
      split = buffer.indexOf("\n");
    }
    if (done) {
      const line = buffer.trim();
      if (line) {
        yield JSON.parse(line);
      }
      return;
    }
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    if (done) {
      buffer += decoder.decode();
    }
  }
}
const { onMount } = svelte;
let rendering_error = null;
const scroll_positions = /* @__PURE__ */ get(SCROLL_KEY) ?? {};
const snapshots = /* @__PURE__ */ get(SNAPSHOT_KEY) ?? {};
const stores = {
  url: /* @__PURE__ */ notifiable_store({}),
  page: /* @__PURE__ */ notifiable_store({}),
  navigating: /* @__PURE__ */ writable(
    /** @type {import('@sveltejs/kit').Navigation | null} */
    null
  ),
  updated: /* @__PURE__ */ create_updated_store()
};
function update_scroll_positions(index) {
  scroll_positions[index] = scroll_state();
}
function clear_onward_history(current_history_index2, current_navigation_index2) {
  let i = current_history_index2 + 1;
  while (scroll_positions[i]) {
    delete scroll_positions[i];
    i += 1;
  }
  i = current_navigation_index2 + 1;
  while (snapshots[i]) {
    delete snapshots[i];
    i += 1;
  }
}
function native_navigation(url, replace = false) {
  if (replace) {
    location.replace(url.href);
  } else {
    location.href = url.href;
  }
  return new Promise(noop);
}
async function update_service_worker() {
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration(base || "/");
    if (registration) {
      await registration.update();
    }
  }
}
let routes;
let default_layout_loader;
let default_error_loader;
let target;
let app;
const invalidated = [];
const components = [];
let load_cache = null;
function discard_load_cache() {
  void load_cache?.fork?.then((f) => f?.discard());
  load_cache = null;
}
const reroute_cache = /* @__PURE__ */ new Map();
const before_navigate_callbacks = /* @__PURE__ */ new Set();
const on_navigate_callbacks = /* @__PURE__ */ new Set();
const after_navigate_callbacks = /* @__PURE__ */ new Set();
let current = {
  branch: [],
  error: null,
  // @ts-ignore - we need the initial value to be null
  url: null
};
let hydrated = false;
let started = false;
let autoscroll = true;
let is_navigating = false;
let force_invalidation = false;
let root;
let current_history_index;
let current_navigation_index;
let token;
const preload_tokens = /* @__PURE__ */ new Set();
const query_map = /* @__PURE__ */ new Map();
const live_query_map = /* @__PURE__ */ new Map();
function reset_invalidation() {
  invalidated.length = 0;
  force_invalidation = false;
}
function capture_snapshot(index) {
  if (components.some((c) => c?.snapshot)) {
    snapshots[index] = components.map((c) => c?.snapshot?.capture());
  }
}
function restore_snapshot(index) {
  snapshots[index]?.forEach((value, i) => {
    components[i]?.snapshot?.restore(value);
  });
}
async function _goto(url, options, redirect_count, nav_token) {
  let query_keys;
  let live_query_keys;
  if (options.invalidateAll) {
    discard_load_cache();
  }
  await navigate({
    type: "goto",
    url: resolve_url(url),
    keepfocus: options.keepFocus,
    noscroll: options.noScroll,
    replace_state: options.replaceState,
    state: options.state,
    redirect_count,
    nav_token,
    accept: () => {
      if (options.invalidateAll) {
        force_invalidation = true;
        query_keys = /* @__PURE__ */ new Set();
        for (const [id, entries] of query_map) {
          for (const payload of entries.keys()) {
            query_keys.add(create_remote_key(id, payload));
          }
        }
        live_query_keys = /* @__PURE__ */ new Set();
        for (const [id, entries] of live_query_map) {
          for (const payload of entries.keys()) {
            live_query_keys.add(create_remote_key(id, payload));
          }
        }
      }
      if (options.invalidate) {
        options.invalidate.forEach(push_invalidated);
      }
    }
  });
  if (options.invalidateAll) {
    void tick().then(tick).then(() => {
      for (const [id, entries] of query_map) {
        for (const [payload, { resource }] of entries) {
          if (query_keys?.has(create_remote_key(id, payload))) {
            void resource.refresh();
          }
        }
      }
      for (const [id, entries] of live_query_map) {
        for (const [payload, { resource }] of entries) {
          if (live_query_keys?.has(create_remote_key(id, payload))) {
            void resource.reconnect();
          }
        }
      }
    });
  }
}
async function initialize(result, target2, hydrate) {
  const nav = {
    params: current.params,
    route: { id: current.route?.id ?? null },
    url: new URL(location.href)
  };
  current = {
    ...result.state,
    nav
  };
  const style = document.querySelector("style[data-sveltekit]");
  if (style) style.remove();
  update(
    /** @type {import('@sveltejs/kit').Page} */
    result.props.page
  );
  root = new app.root({
    target: target2,
    props: { ...result.props, stores, components },
    hydrate,
    // @ts-ignore Svelte 5 specific: asynchronously instantiate the component, i.e. don't call flushSync
    sync: false,
    // @ts-ignore Svelte 5 specific: transformError allows to transform errors before they are passed to boundaries
    transformError: void 0
  });
  void await Promise.resolve();
  restore_snapshot(current_navigation_index);
  started = true;
}
async function get_navigation_result_from_branch({
  url,
  params,
  branch,
  errors,
  status,
  error,
  route,
  form
}) {
  let slash = "never";
  if (base && (url.pathname === base || url.pathname === base + "/")) {
    slash = "always";
  } else {
    for (const node of branch) {
      if (node?.slash !== void 0) slash = node.slash;
    }
  }
  url.pathname = normalize_path(url.pathname, slash);
  url.search = url.search;
  const result = {
    type: "loaded",
    state: {
      url,
      params,
      branch,
      error,
      route
    },
    props: {
      // @ts-ignore Somehow it's getting SvelteComponent and SvelteComponentDev mixed up
      constructors: compact(branch).map((branch_node) => branch_node.node.component),
      page: clone_page(page)
    }
  };
  if (form !== void 0) {
    result.props.form = form;
  }
  let data = {};
  let data_changed = !page;
  let p = 0;
  for (let i = 0; i < Math.max(branch.length, current.branch.length); i += 1) {
    const node = branch[i];
    const prev = current.branch[i];
    if (node?.data !== prev?.data) data_changed = true;
    if (!node) continue;
    data = { ...data, ...node.data };
    if (data_changed) {
      result.props[`data_${p}`] = data;
    }
    p += 1;
  }
  const page_changed = !current.url || url.href !== current.url.href || current.error !== error || form !== void 0 && form !== page.form || data_changed;
  if (page_changed) {
    result.props.page = {
      error,
      params,
      route: {
        id: route?.id ?? null
      },
      state: {},
      status,
      url: new URL(url),
      form: form ?? null,
      // The whole page store is updated, but this way the object reference stays the same
      data: data_changed ? data : page.data
    };
  }
  return result;
}
async function load_node({ loader, parent, url, params, route, server_data_node }) {
  let data = null;
  let is_tracking = true;
  const uses = {
    dependencies: /* @__PURE__ */ new Set(),
    params: /* @__PURE__ */ new Set(),
    parent: false,
    route: false,
    url: false,
    search_params: /* @__PURE__ */ new Set()
  };
  const node = await loader();
  if (node.universal?.load) {
    let depends = function(...deps) {
      for (const dep of deps) {
        const { href } = new URL(dep, url);
        uses.dependencies.add(href);
      }
    };
    const load_input = {
      tracing: { enabled: false, root: noop_span, current: noop_span },
      route: new Proxy(route, {
        get: (target2, key) => {
          if (is_tracking) {
            uses.route = true;
          }
          return target2[
            /** @type {'id'} */
            key
          ];
        }
      }),
      params: new Proxy(params, {
        get: (target2, key) => {
          if (is_tracking) {
            uses.params.add(
              /** @type {string} */
              key
            );
          }
          return target2[
            /** @type {string} */
            key
          ];
        }
      }),
      data: server_data_node?.data ?? null,
      url: make_trackable(
        url,
        () => {
          if (is_tracking) {
            uses.url = true;
          }
        },
        (param) => {
          if (is_tracking) {
            uses.search_params.add(param);
          }
        },
        app.hash
      ),
      async fetch(resource, init) {
        if (resource instanceof Request) {
          init = {
            // the request body must be consumed in memory until browsers
            // implement streaming request bodies and/or the body getter
            body: resource.method === "GET" || resource.method === "HEAD" ? void 0 : await resource.blob(),
            cache: resource.cache,
            credentials: resource.credentials,
            // the server sets headers to `undefined` if there are no headers but
            // the client defaults to an empty Headers object in the Request object.
            // To keep the two values in sync, we explicitly set the headers to `undefined`.
            // Also, not sure why, but sometimes 0 is evaluated as truthy so we need to
            // explicitly compare the headers length to a number here
            headers: [...resource.headers].length > 0 ? resource?.headers : void 0,
            integrity: resource.integrity,
            keepalive: resource.keepalive,
            method: resource.method,
            mode: resource.mode,
            redirect: resource.redirect,
            referrer: resource.referrer,
            referrerPolicy: resource.referrerPolicy,
            signal: resource.signal,
            ...init
          };
        }
        const { resolved, promise } = resolve_fetch_url(resource, init, url);
        if (is_tracking) {
          depends(resolved.href);
        }
        return promise;
      },
      setHeaders: noop,
      depends,
      parent() {
        if (is_tracking) {
          uses.parent = true;
        }
        return parent();
      },
      untrack(fn) {
        is_tracking = false;
        try {
          return fn();
        } finally {
          is_tracking = true;
        }
      }
    };
    {
      data = await node.universal.load.call(null, load_input) ?? null;
    }
  }
  return {
    node,
    loader,
    server: server_data_node,
    universal: node.universal?.load ? { type: "data", data, uses } : null,
    data: data ?? server_data_node?.data ?? null,
    slash: node.universal?.trailingSlash ?? server_data_node?.slash
  };
}
function resolve_fetch_url(input, init, url) {
  let requested = input instanceof Request ? input.url : input;
  const resolved = new URL(requested, url);
  if (resolved.origin === url.origin) {
    requested = resolved.href.slice(url.origin.length);
  }
  const promise = started ? subsequent_fetch(requested, resolved.href, init) : initial_fetch(requested, init);
  return { resolved, promise };
}
function has_changed(parent_changed, route_changed, url_changed, search_params_changed, uses, params) {
  if (force_invalidation) return true;
  if (!uses) return false;
  if (uses.parent && parent_changed) return true;
  if (uses.route && route_changed) return true;
  if (uses.url && url_changed) return true;
  for (const tracked_params of uses.search_params) {
    if (search_params_changed.has(tracked_params)) return true;
  }
  for (const param of uses.params) {
    if (params[param] !== current.params[param]) return true;
  }
  for (const href of uses.dependencies) {
    if (invalidated.some((fn) => fn(new URL(href)))) return true;
  }
  return false;
}
function create_data_node(node, previous) {
  if (node?.type === "data") return node;
  if (node?.type === "skip") return previous ?? null;
  return null;
}
function diff_search_params(old_url, new_url) {
  if (!old_url) return new Set(new_url.searchParams.keys());
  const changed = /* @__PURE__ */ new Set([...old_url.searchParams.keys(), ...new_url.searchParams.keys()]);
  for (const key of changed) {
    const old_values = old_url.searchParams.getAll(key);
    const new_values = new_url.searchParams.getAll(key);
    if (old_values.every((value) => new_values.includes(value)) && new_values.every((value) => old_values.includes(value))) {
      changed.delete(key);
    }
  }
  return changed;
}
function preload_error({ error, url, route, params }) {
  return {
    type: "loaded",
    state: {
      error,
      url,
      route,
      params,
      branch: []
    },
    props: {
      page: clone_page(page),
      constructors: []
    }
  };
}
async function load_route({ id, invalidating, url, params, route, preload }) {
  if (load_cache?.id === id) {
    preload_tokens.delete(load_cache.token);
    return load_cache.promise;
  }
  const { errors, layouts, leaf } = route;
  const loaders = [...layouts, leaf];
  errors.forEach((loader) => loader?.().catch(noop));
  loaders.forEach((loader) => loader?.[1]().catch(noop));
  let server_data = null;
  const url_changed = current.url ? id !== get_page_key(current.url) : false;
  const route_changed = current.route ? route.id !== current.route.id : false;
  const search_params_changed = diff_search_params(current.url, url);
  let parent_invalid = false;
  {
    const invalid_server_nodes = loaders.map((loader, i) => {
      const previous = current.branch[i];
      const invalid = !!loader?.[0] && (previous?.loader !== loader[1] || has_changed(
        parent_invalid,
        route_changed,
        url_changed,
        search_params_changed,
        previous.server?.uses,
        params
      ));
      if (invalid) {
        parent_invalid = true;
      }
      return invalid;
    });
    if (invalid_server_nodes.some(Boolean)) {
      try {
        server_data = await load_data(url, invalid_server_nodes);
      } catch (error) {
        const handled_error = await handle_error(error, { url, params, route: { id } });
        if (preload_tokens.has(preload)) {
          return preload_error({ error: handled_error, url, params, route });
        }
        return load_root_error_page({
          status: get_status(error),
          error: handled_error,
          url,
          route
        });
      }
      if (server_data.type === "redirect") {
        return server_data;
      }
    }
  }
  const server_data_nodes = server_data?.nodes;
  let parent_changed = false;
  const branch_promises = loaders.map(async (loader, i) => {
    if (!loader) return;
    const previous = current.branch[i];
    const server_data_node = server_data_nodes?.[i];
    const valid = (!server_data_node || server_data_node.type === "skip") && loader[1] === previous?.loader && !has_changed(
      parent_changed,
      route_changed,
      url_changed,
      search_params_changed,
      previous.universal?.uses,
      params
    );
    if (valid) return previous;
    parent_changed = true;
    if (server_data_node?.type === "error") {
      throw server_data_node;
    }
    return load_node({
      loader: loader[1],
      url,
      params,
      route,
      parent: async () => {
        const data = {};
        for (let j = 0; j < i; j += 1) {
          Object.assign(data, (await branch_promises[j])?.data);
        }
        return data;
      },
      server_data_node: create_data_node(
        // server_data_node is undefined if it wasn't reloaded from the server;
        // and if current loader uses server data, we want to reuse previous data.
        server_data_node === void 0 && loader[0] ? { type: "skip" } : server_data_node ?? null,
        loader[0] ? previous?.server : void 0
      )
    });
  });
  for (const p of branch_promises) p.catch(noop);
  const branch = [];
  for (let i = 0; i < loaders.length; i += 1) {
    if (loaders[i]) {
      try {
        branch.push(await branch_promises[i]);
      } catch (err) {
        if (err instanceof Redirect) {
          return {
            type: "redirect",
            location: err.location
          };
        }
        if (preload_tokens.has(preload)) {
          return preload_error({
            error: await handle_error(err, { params, url, route: { id: route.id } }),
            url,
            params,
            route
          });
        }
        let status = get_status(err);
        let error;
        if (server_data_nodes?.includes(
          /** @type {import('types').ServerErrorNode} */
          err
        )) {
          status = /** @type {import('types').ServerErrorNode} */
          err.status ?? status;
          error = /** @type {import('types').ServerErrorNode} */
          err.error;
        } else if (err instanceof HttpError) {
          error = err.body;
        } else {
          const updated2 = await stores.updated.check();
          if (updated2) {
            await update_service_worker();
            return await native_navigation(url);
          }
          error = await handle_error(err, { params, url, route: { id: route.id } });
        }
        const error_load = await load_nearest_error_page(i, branch, errors);
        if (error_load) {
          return get_navigation_result_from_branch({
            url,
            params,
            branch: branch.slice(0, error_load.idx).concat(error_load.node),
            errors,
            status,
            error,
            route
          });
        } else {
          return await server_fallback(url, { id: route.id }, error, status);
        }
      }
    } else {
      branch.push(void 0);
    }
  }
  return get_navigation_result_from_branch({
    url,
    params,
    branch,
    errors,
    status: 200,
    error: null,
    route,
    // Reset `form` on navigation, but not invalidation
    form: invalidating ? void 0 : null
  });
}
async function load_nearest_error_page(i, branch, errors) {
  while (i--) {
    if (errors[i]) {
      let j = i;
      while (!branch[j]) j -= 1;
      try {
        return {
          idx: j + 1,
          node: {
            node: await /** @type {import('types').CSRPageNodeLoader } */
            errors[i](),
            loader: (
              /** @type {import('types').CSRPageNodeLoader } */
              errors[i]
            ),
            data: {},
            server: null,
            universal: null
          }
        };
      } catch {
        continue;
      }
    }
  }
}
async function load_root_error_page({ status, error, url, route }) {
  const params = {};
  let server_data_node = null;
  {
    const default_layout_has_server_load = app.server_loads[0] === 0;
    if (default_layout_has_server_load) {
      try {
        const server_data = await load_data(url, [true]);
        if (server_data.type !== "data" || server_data.nodes[0] && server_data.nodes[0].type !== "data") {
          throw 0;
        }
        server_data_node = server_data.nodes[0] ?? null;
      } catch {
        if (url.origin !== origin || url.pathname !== location.pathname || hydrated) {
          await native_navigation(url);
        }
      }
    }
  }
  try {
    const root_layout = await load_node({
      loader: default_layout_loader,
      url,
      params,
      route,
      parent: () => Promise.resolve({}),
      server_data_node: create_data_node(server_data_node)
    });
    const root_error = {
      node: await default_error_loader(),
      loader: default_error_loader,
      universal: null,
      server: null,
      data: null
    };
    return get_navigation_result_from_branch({
      url,
      params,
      branch: [root_layout, root_error],
      status,
      error,
      errors: [],
      route: null
    });
  } catch (error2) {
    if (error2 instanceof Redirect) {
      return _goto(new URL(error2.location, location.href), {}, 0);
    }
    throw error2;
  }
}
async function get_rerouted_url(url) {
  const href = url.href;
  if (reroute_cache.has(href)) {
    return reroute_cache.get(href);
  }
  let rerouted;
  try {
    const promise = (async () => {
      let rerouted2 = await app.hooks.reroute({
        url: new URL(url),
        fetch: async (input, init) => {
          return resolve_fetch_url(input, init, url).promise;
        }
      }) ?? url;
      if (typeof rerouted2 === "string") {
        const tmp = new URL(url);
        if (app.hash) {
          tmp.hash = rerouted2;
        } else {
          tmp.pathname = rerouted2;
        }
        rerouted2 = tmp;
      }
      return rerouted2;
    })();
    reroute_cache.set(href, promise);
    rerouted = await promise;
  } catch (e) {
    reroute_cache.delete(href);
    return;
  }
  return rerouted;
}
async function get_navigation_intent(url, invalidating) {
  if (!url) return;
  if (is_external_url(url, base, app.hash)) return;
  {
    const rerouted = await get_rerouted_url(url);
    if (!rerouted) return;
    const path = get_url_path(rerouted);
    for (const route of routes) {
      const params = route.exec(path);
      if (params) {
        return {
          id: get_page_key(url),
          invalidating,
          route,
          params: decode_params(params),
          url
        };
      }
    }
  }
}
function get_url_path(url) {
  return decode_pathname(
    app.hash ? url.hash.replace(/^#/, "").replace(/[?#].+/, "") : url.pathname.slice(base.length)
  ) || "/";
}
function get_page_key(url) {
  return (app.hash ? url.hash.replace(/^#/, "") : url.pathname) + url.search;
}
function _before_navigate({ url, type, intent, delta, event, scroll }) {
  let should_block = false;
  const nav = create_navigation(current, intent, url, type, scroll ?? null);
  if (delta !== void 0) {
    nav.navigation.delta = delta;
  }
  if (event !== void 0) {
    nav.navigation.event = event;
  }
  const cancellable = {
    ...nav.navigation,
    cancel: () => {
      should_block = true;
      nav.reject(new Error("navigation cancelled"));
    }
  };
  if (!is_navigating) {
    before_navigate_callbacks.forEach((fn) => fn(cancellable));
  }
  return should_block ? null : nav;
}
async function navigate({
  type,
  url,
  popped,
  keepfocus,
  noscroll,
  replace_state,
  state = {},
  redirect_count = 0,
  nav_token = {},
  accept = noop,
  block = noop,
  event
}) {
  const prev_token = token;
  token = nav_token;
  const intent = await get_navigation_intent(url, false);
  const nav = _before_navigate({
    url,
    type,
    delta: popped?.delta,
    intent,
    scroll: popped?.scroll,
    // @ts-ignore
    event
  });
  if (!nav) {
    block();
    if (token === nav_token) token = prev_token;
    return;
  }
  const previous_history_index = current_history_index;
  const previous_navigation_index = current_navigation_index;
  accept();
  is_navigating = true;
  if (started && nav.navigation.type !== "enter") {
    stores.navigating.set(navigating.current = nav.navigation);
  }
  let navigation_result = intent && await load_route(intent);
  if (!navigation_result) {
    if (is_external_url(url, base, app.hash)) {
      {
        return await native_navigation(url, replace_state);
      }
    } else {
      navigation_result = await server_fallback(
        url,
        { id: null },
        await handle_error(new SvelteKitError(404, "Not Found", `Not found: ${url.pathname}`), {
          url,
          params: {},
          route: { id: null }
        }),
        404,
        replace_state
      );
    }
  }
  url = intent?.url || url;
  if (token !== nav_token) {
    nav.reject(new Error("navigation aborted"));
    return false;
  }
  if (navigation_result.type === "redirect") {
    if (redirect_count < 20) {
      await navigate({
        type,
        url: new URL(navigation_result.location, url),
        popped,
        keepfocus,
        noscroll,
        replace_state,
        state,
        redirect_count: redirect_count + 1,
        nav_token
      });
      nav.fulfil(void 0);
      return;
    }
    navigation_result = await load_root_error_page({
      status: 500,
      error: await handle_error(new Error("Redirect loop"), {
        url,
        params: {},
        route: { id: null }
      }),
      url,
      route: { id: null }
    });
  } else if (
    /** @type {number} */
    navigation_result.props.page.status >= 400
  ) {
    const updated2 = await stores.updated.check();
    if (updated2) {
      await update_service_worker();
      await native_navigation(url, replace_state);
    }
  }
  reset_invalidation();
  update_scroll_positions(previous_history_index);
  capture_snapshot(previous_navigation_index);
  if (navigation_result.props.page.url.pathname !== url.pathname) {
    url.pathname = navigation_result.props.page.url.pathname;
  }
  state = popped ? popped.state : state;
  if (!popped) {
    const change = replace_state ? 0 : 1;
    const entry = {
      [HISTORY_INDEX]: current_history_index += change,
      [NAVIGATION_INDEX]: current_navigation_index += change,
      [STATES_KEY]: state
    };
    const fn = replace_state ? history.replaceState : history.pushState;
    fn.call(history, entry, "", url);
    if (!replace_state) {
      clear_onward_history(current_history_index, current_navigation_index);
    }
  }
  const load_cache_fork = intent && load_cache?.id === intent.id ? load_cache.fork : null;
  if (load_cache?.fork && !load_cache_fork) {
    discard_load_cache();
  }
  load_cache = null;
  navigation_result.props.page.state = state;
  let commit_promise;
  if (started) {
    const after_navigate = (await Promise.all(
      // eslint-disable-next-line @typescript-eslint/await-thenable -- we need to await because they can be asynchronous
      Array.from(
        on_navigate_callbacks,
        (fn) => fn(
          /** @type {import('@sveltejs/kit').OnNavigate} */
          nav.navigation
        )
      )
    )).filter(
      /** @returns {value is () => void} */
      (value) => typeof value === "function"
    );
    if (after_navigate.length > 0) {
      let cleanup = function() {
        after_navigate.forEach((fn) => {
          after_navigate_callbacks.delete(fn);
        });
      };
      after_navigate.push(cleanup);
      after_navigate.forEach((fn) => {
        after_navigate_callbacks.add(fn);
      });
    }
    const target2 = (
      /** @type {import('@sveltejs/kit').NavigationTarget} */
      nav.navigation.to
    );
    current = {
      ...navigation_result.state,
      nav: {
        params: (
          /** @type {Record<string, any>} */
          target2.params
        ),
        route: target2.route,
        url: target2.url
      }
    };
    if (navigation_result.props.page) {
      navigation_result.props.page.url = url;
    }
    const fork = load_cache_fork && await load_cache_fork;
    if (fork) {
      commit_promise = fork.commit();
    } else {
      rendering_error = null;
      root.$set(navigation_result.props);
      if (rendering_error) {
        Object.assign(navigation_result.props.page, rendering_error);
      }
      update(navigation_result.props.page);
      commit_promise = settled?.();
    }
  } else {
    await initialize(navigation_result, target, false);
  }
  const { activeElement } = document;
  await commit_promise;
  await tick();
  await tick();
  if (token !== nav_token) {
    nav.reject(new Error("navigation aborted"));
    return false;
  }
  if (navigation_result.props.page && rendering_error) {
    Object.assign(navigation_result.props.page, rendering_error);
  }
  let deep_linked = null;
  if (autoscroll) {
    const scroll = popped ? popped.scroll : noscroll ? scroll_state() : null;
    if (scroll) {
      scrollTo(scroll.x, scroll.y);
    } else if (deep_linked = url.hash && document.getElementById(get_id(url))) {
      deep_linked.scrollIntoView();
    } else {
      scrollTo(0, 0);
    }
  }
  const changed_focus = (
    // reset focus only if any manual focus management didn't override it
    document.activeElement !== activeElement && // also refocus when activeElement is body already because the
    // focus event might not have been fired on it yet
    document.activeElement !== document.body
  );
  if (!keepfocus && !changed_focus) {
    reset_focus(url, !deep_linked);
  }
  autoscroll = true;
  is_navigating = false;
  nav.fulfil(void 0);
  if (nav.navigation.to) {
    nav.navigation.to.scroll = scroll_state();
  }
  after_navigate_callbacks.forEach(
    (fn) => fn(
      /** @type {import('@sveltejs/kit').AfterNavigate} */
      nav.navigation
    )
  );
  stores.navigating.set(navigating.current = null);
}
async function server_fallback(url, route, error, status, replace_state) {
  if (url.origin === origin && url.pathname === location.pathname && !hydrated) {
    return await load_root_error_page({
      status,
      error,
      url,
      route
    });
  }
  return await native_navigation(url, replace_state);
}
function handle_error(error, event) {
  if (error instanceof HttpError) {
    return error.body;
  }
  const status = get_status(error);
  const message = get_message(error);
  return app.hooks.handleError({ error, event, status, message }) ?? /** @type {any} */
  { message };
}
function add_navigation_callback(callbacks, callback) {
  onMount(() => {
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  });
}
function afterNavigate(callback) {
  add_navigation_callback(after_navigate_callbacks, callback);
}
function goto(url, opts = {}) {
  url = new URL(resolve_url(url));
  if (url.origin !== origin) {
    return Promise.reject(
      new Error(
        "goto: invalid URL"
      )
    );
  }
  return _goto(url, opts, 0);
}
function push_invalidated(resource) {
  if (typeof resource === "function") {
    invalidated.push(resource);
  } else {
    const { href } = new URL(resource, location.href);
    invalidated.push((url) => url.href === href);
  }
}
async function load_data(url, invalid) {
  const data_url = new URL(url);
  data_url.pathname = add_data_suffix(url.pathname);
  if (url.pathname.endsWith("/")) {
    data_url.searchParams.append(TRAILING_SLASH_PARAM, "1");
  }
  data_url.searchParams.append(INVALIDATED_PARAM, invalid.map((i) => i ? "1" : "0").join(""));
  const fetcher = window.fetch;
  const res = await fetcher(data_url.href, {});
  if (!res.ok) {
    let message;
    if (res.headers.get("content-type")?.includes("application/json")) {
      message = await res.json();
    } else if (res.status === 404) {
      message = "Not Found";
    } else if (res.status === 500) {
      message = "Internal Error";
    }
    throw new HttpError(res.status, message);
  }
  return new Promise(async (resolve) => {
    const deferreds = /* @__PURE__ */ new Map();
    const reader = (
      /** @type {ReadableStream<Uint8Array>} */
      res.body.getReader()
    );
    function deserialize(data) {
      return devalue.unflatten(data, {
        ...app.decoders,
        Promise: (id) => {
          return new Promise((fulfil, reject) => {
            deferreds.set(id, { fulfil, reject });
          });
        }
      });
    }
    for await (const node of read_ndjson(reader)) {
      if (node.type === "redirect") {
        return resolve(node);
      }
      if (node.type === "data") {
        node.nodes?.forEach((node2) => {
          if (node2?.type === "data") {
            node2.uses = deserialize_uses(node2.uses);
            node2.data = deserialize(node2.data);
          }
        });
        resolve(node);
      } else if (node.type === "chunk") {
        const { id, data, error } = node;
        const deferred = (
          /** @type {import('types').Deferred} */
          deferreds.get(id)
        );
        deferreds.delete(id);
        if (error) {
          deferred.reject(deserialize(error));
        } else {
          deferred.fulfil(deserialize(data));
        }
      }
    }
  });
}
function deserialize_uses(uses) {
  return {
    dependencies: new Set(uses?.dependencies ?? []),
    params: new Set(uses?.params ?? []),
    parent: !!uses?.parent,
    route: !!uses?.route,
    url: !!uses?.url,
    search_params: new Set(uses?.search_params ?? [])
  };
}
function reset_focus(url, scroll = true) {
  const autofocus = document.querySelector("[autofocus]");
  if (autofocus) {
    autofocus.focus();
  } else {
    const id = get_id(url);
    if (id && document.getElementById(id)) {
      const { x, y } = scroll_state();
      setTimeout(() => {
        const history_state = history.state;
        location.replace(new URL(`#${id}`, location.href));
        history.replaceState(history_state, "", url);
        if (scroll) scrollTo(x, y);
      });
    } else {
      const root2 = document.body;
      const tabindex = root2.getAttribute("tabindex");
      root2.tabIndex = -1;
      root2.focus({ preventScroll: true, focusVisible: false });
      if (tabindex !== null) {
        root2.setAttribute("tabindex", tabindex);
      } else {
        root2.removeAttribute("tabindex");
      }
    }
    const selection = getSelection();
    if (selection && selection.type !== "None") {
      const ranges = [];
      for (let i = 0; i < selection.rangeCount; i += 1) {
        ranges.push(selection.getRangeAt(i));
      }
      setTimeout(() => {
        if (selection.rangeCount !== ranges.length) return;
        for (let i = 0; i < selection.rangeCount; i += 1) {
          const a = ranges[i];
          const b = selection.getRangeAt(i);
          if (a.commonAncestorContainer !== b.commonAncestorContainer || a.startContainer !== b.startContainer || a.endContainer !== b.endContainer || a.startOffset !== b.startOffset || a.endOffset !== b.endOffset) {
            return;
          }
        }
        selection.removeAllRanges();
      });
    }
  }
}
function create_navigation(current2, intent, url, type, target_scroll = null) {
  let fulfil;
  let reject;
  const complete = new Promise((f, r) => {
    fulfil = f;
    reject = r;
  });
  complete.catch(noop);
  const navigation = (
    /** @type {any} */
    {
      from: {
        params: current2.params,
        route: { id: current2.route?.id ?? null },
        url: current2.url,
        scroll: scroll_state()
      },
      to: url && {
        params: intent?.params ?? null,
        route: { id: intent?.route?.id ?? null },
        url,
        scroll: target_scroll
      },
      willUnload: !intent,
      type,
      complete
    }
  );
  return {
    navigation,
    // @ts-expect-error
    fulfil,
    // @ts-expect-error
    reject
  };
}
function clone_page(page2) {
  return {
    data: page2.data,
    error: page2.error,
    form: page2.form,
    params: page2.params,
    route: page2.route,
    state: page2.state,
    status: page2.status,
    url: page2.url
  };
}
function get_id(url) {
  let id;
  if (app.hash) {
    const [, , second] = url.hash.split("#", 3);
    id = second ?? "";
  } else {
    id = url.hash.slice(1);
  }
  return decodeURIComponent(id);
}
export {
  afterNavigate as a,
  goto as g,
  page as p,
  stores as s,
  updated as u
};
