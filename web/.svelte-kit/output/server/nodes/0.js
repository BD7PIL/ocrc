

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const universal = {
  "ssr": false,
  "prerender": false,
  "trailingSlash": "always"
};
export const universal_id = "src/routes/+layout.ts";
export const imports = ["_app/immutable/nodes/0.BIX8gE0R.js","_app/immutable/chunks/CWj6FrbW.js","_app/immutable/chunks/DjcydBvx.js","_app/immutable/chunks/BSrpC7qP.js","_app/immutable/chunks/DV-RItsm.js","_app/immutable/chunks/L-yNbUX_.js","_app/immutable/chunks/BMcRplr0.js","_app/immutable/chunks/B0NGGAKm.js","_app/immutable/chunks/jmfqSi5Y.js"];
export const stylesheets = ["_app/immutable/assets/summarizeTodos.Cz1PIwC7.css","_app/immutable/assets/0.DTzZxc7_.css"];
export const fonts = [];
