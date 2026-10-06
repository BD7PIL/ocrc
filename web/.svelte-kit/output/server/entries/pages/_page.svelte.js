import { g as store_get, u as unsubscribe_stores } from "../../chunks/index.js";
import { g as goto } from "../../chunks/client.js";
import { j as backends, w as sessionList, i as backendName } from "../../chunks/capabilities.js";
import { e as escape_html } from "../../chunks/index-client.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let activeBackendId, agentSessions;
    const isMobile = window.matchMedia("(max-width: 820px)").matches;
    let redirected = false;
    activeBackendId = store_get($$store_subs ??= {}, "$backends", backends)?.activeId;
    agentSessions = activeBackendId ? store_get($$store_subs ??= {}, "$sessionList", sessionList).filter((s) => s.backendId === activeBackendId || !s.backendId && activeBackendId === "opencode").sort((a, b) => b.lastActiveAt - a.lastActiveAt) : [
      ...store_get($$store_subs ??= {}, "$sessionList", sessionList)
    ].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    if (!redirected && !isMobile && agentSessions.length > 0) {
      redirected = true;
      goto(`/${agentSessions[0].id}/`, { replaceState: true });
    }
    $$renderer2.push(`<div class="empty svelte-1uha8ag">`);
    if (store_get($$store_subs ??= {}, "$sessionList", sessionList).length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`No sessions yet — create one to start chatting with ${escape_html(store_get($$store_subs ??= {}, "$backendName", backendName))}.`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`Opening latest session…`);
    }
    $$renderer2.push(`<!--]--></div>`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
export {
  _page as default
};
