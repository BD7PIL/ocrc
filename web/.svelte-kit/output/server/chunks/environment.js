const DEV = false;
var is_array = Array.isArray;
var index_of = Array.prototype.indexOf;
var includes = Array.prototype.includes;
var array_from = Array.from;
var define_property = Object.defineProperty;
var get_descriptor = Object.getOwnPropertyDescriptor;
var object_prototype = Object.prototype;
var array_prototype = Array.prototype;
var get_prototype_of = Object.getPrototypeOf;
var is_extensible = Object.isExtensible;
var has_own_property = Object.prototype.hasOwnProperty;
const noop = () => {
};
function run_all(arr) {
  for (var i = 0; i < arr.length; i++) {
    arr[i]();
  }
}
function deferred() {
  var resolve;
  var reject;
  var promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function fallback(value, fallback2, lazy = false) {
  return value === void 0 ? lazy ? (
    /** @type {() => V} */
    fallback2()
  ) : (
    /** @type {V} */
    fallback2
  ) : value;
}
const DERIVED = 1 << 1;
const EFFECT = 1 << 2;
const RENDER_EFFECT = 1 << 3;
const MANAGED_EFFECT = 1 << 24;
const BLOCK_EFFECT = 1 << 4;
const BRANCH_EFFECT = 1 << 5;
const ROOT_EFFECT = 1 << 6;
const BOUNDARY_EFFECT = 1 << 7;
const CONNECTED = 1 << 9;
const CLEAN = 1 << 10;
const DIRTY = 1 << 11;
const MAYBE_DIRTY = 1 << 12;
const INERT = 1 << 13;
const DESTROYED = 1 << 14;
const REACTION_RAN = 1 << 15;
const DESTROYING = 1 << 25;
const EFFECT_TRANSPARENT = 1 << 16;
const EAGER_EFFECT = 1 << 17;
const HEAD_EFFECT = 1 << 18;
const EFFECT_PRESERVED = 1 << 19;
const USER_EFFECT = 1 << 20;
const WAS_MARKED = 1 << 16;
const REACTION_IS_UPDATING = 1 << 21;
const ASYNC = 1 << 22;
const ERROR_VALUE = 1 << 23;
const STATE_SYMBOL = Symbol("$state");
const LEGACY_PROPS = Symbol("legacy props");
const ATTRIBUTES_CACHE = Symbol("attributes");
const CLASS_CACHE = Symbol("class");
const STYLE_CACHE = Symbol("style");
const TEXT_CACHE = Symbol("text");
const STALE_REACTION = new class StaleReactionError extends Error {
  name = "StaleReactionError";
  message = "The reaction that called `getAbortSignal()` was re-run or destroyed";
}();
const COMMENT_NODE = 8;
function experimental_async_required(name) {
  {
    throw new Error(`https://svelte.dev/e/experimental_async_required`);
  }
}
function lifecycle_outside_component(name) {
  {
    throw new Error(`https://svelte.dev/e/lifecycle_outside_component`);
  }
}
const HYDRATION_START = "[";
const HYDRATION_START_ELSE = "[!";
const HYDRATION_START_FAILED = "[?";
const HYDRATION_END = "]";
const HYDRATION_ERROR = {};
const UNINITIALIZED = Symbol();
function derived_inert() {
  {
    console.warn(`https://svelte.dev/e/derived_inert`);
  }
}
function hydratable_missing_but_expected(key) {
  {
    console.warn(`https://svelte.dev/e/hydratable_missing_but_expected`);
  }
}
function hydration_mismatch(location) {
  {
    console.warn(`https://svelte.dev/e/hydration_mismatch`);
  }
}
function svelte_boundary_reset_noop() {
  {
    console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`);
  }
}
let hydrating = false;
function set_hydrating(value) {
  hydrating = value;
}
let hydrate_node;
function set_hydrate_node(node) {
  if (node === null) {
    hydration_mismatch();
    throw HYDRATION_ERROR;
  }
  return hydrate_node = node;
}
function hydrate_next() {
  return set_hydrate_node(/* @__PURE__ */ get_next_sibling(hydrate_node));
}
function next(count = 1) {
  if (hydrating) {
    var i = count;
    var node = hydrate_node;
    while (i--) {
      node = /** @type {TemplateNode} */
      /* @__PURE__ */ get_next_sibling(node);
    }
    hydrate_node = node;
  }
}
function skip_nodes(remove = true) {
  var depth = 0;
  var node = hydrate_node;
  while (true) {
    if (node.nodeType === COMMENT_NODE) {
      var data = (
        /** @type {Comment} */
        node.data
      );
      if (data === HYDRATION_END) {
        if (depth === 0) return node;
        depth -= 1;
      } else if (data === HYDRATION_START || data === HYDRATION_START_ELSE || // "[1", "[2", etc. for if blocks
      data[0] === "[" && !isNaN(Number(data.slice(1)))) {
        depth += 1;
      }
    }
    var next2 = (
      /** @type {TemplateNode} */
      /* @__PURE__ */ get_next_sibling(node)
    );
    if (remove) node.remove();
    node = next2;
  }
}
var $window;
var first_child_getter;
var next_sibling_getter;
function init_operations() {
  if ($window !== void 0) {
    return;
  }
  $window = window;
  var element_prototype = Element.prototype;
  var node_prototype = Node.prototype;
  var text_prototype = Text.prototype;
  first_child_getter = get_descriptor(node_prototype, "firstChild").get;
  next_sibling_getter = get_descriptor(node_prototype, "nextSibling").get;
  if (is_extensible(element_prototype)) {
    element_prototype[CLASS_CACHE] = void 0;
    element_prototype[ATTRIBUTES_CACHE] = null;
    element_prototype[STYLE_CACHE] = void 0;
    element_prototype.__e = void 0;
  }
  if (is_extensible(text_prototype)) {
    text_prototype[TEXT_CACHE] = void 0;
  }
}
function create_text(value = "") {
  return document.createTextNode(value);
}
// @__NO_SIDE_EFFECTS__
function get_first_child(node) {
  return (
    /** @type {TemplateNode | null} */
    first_child_getter.call(node)
  );
}
// @__NO_SIDE_EFFECTS__
function get_next_sibling(node) {
  return (
    /** @type {TemplateNode | null} */
    next_sibling_getter.call(node)
  );
}
function clear_text_content(node) {
  node.textContent = "";
}
function hydratable(key, fn) {
  {
    experimental_async_required();
  }
  if (hydrating) {
    const store = window.__svelte?.h;
    if (store?.has(key)) {
      return (
        /** @type {T} */
        store.get(key)
      );
    }
    {
      hydratable_missing_but_expected();
    }
  }
  return fn();
}
const version = "1791326849287";
let prerendering = false;
function set_building() {
}
function set_prerendering() {
  prerendering = true;
}
export {
  hydration_mismatch as $,
  ASYNC as A,
  BLOCK_EFFECT as B,
  CLEAN as C,
  DERIVED as D,
  EAGER_EFFECT as E,
  create_text as F,
  deferred as G,
  HEAD_EFFECT as H,
  INERT as I,
  define_property as J,
  derived_inert as K,
  LEGACY_PROPS as L,
  MANAGED_EFFECT as M,
  fallback as N,
  get_descriptor as O,
  get_first_child as P,
  get_next_sibling as Q,
  REACTION_IS_UPDATING as R,
  STALE_REACTION as S,
  get_prototype_of as T,
  UNINITIALIZED as U,
  has_own_property as V,
  WAS_MARKED as W,
  hydratable as X,
  hydrate_next as Y,
  hydrate_node as Z,
  hydrating as _,
  BOUNDARY_EFFECT as a,
  includes as a0,
  index_of as a1,
  init_operations as a2,
  is_array as a3,
  lifecycle_outside_component as a4,
  next as a5,
  noop as a6,
  object_prototype as a7,
  prerendering as a8,
  run_all as a9,
  set_building as aa,
  set_hydrate_node as ab,
  set_hydrating as ac,
  set_prerendering as ad,
  skip_nodes as ae,
  svelte_boundary_reset_noop as af,
  version as ag,
  BRANCH_EFFECT as b,
  COMMENT_NODE as c,
  CONNECTED as d,
  DESTROYED as e,
  DESTROYING as f,
  DEV as g,
  DIRTY as h,
  EFFECT as i,
  EFFECT_PRESERVED as j,
  EFFECT_TRANSPARENT as k,
  ERROR_VALUE as l,
  HYDRATION_END as m,
  HYDRATION_ERROR as n,
  HYDRATION_START as o,
  HYDRATION_START_ELSE as p,
  HYDRATION_START_FAILED as q,
  MAYBE_DIRTY as r,
  REACTION_RAN as s,
  RENDER_EFFECT as t,
  ROOT_EFFECT as u,
  STATE_SYMBOL as v,
  USER_EFFECT as w,
  array_from as x,
  array_prototype as y,
  clear_text_content as z
};
