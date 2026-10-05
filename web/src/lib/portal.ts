// portal.ts — Svelte action: move a node to a different DOM host (default
// document.body) on mount. Escape hatch for fixed-position surfaces rendered
// inside stacking contexts that would trap them (e.g. the inspector wrap has
// z-index:1 + a transform transition, which pins even z-modal:300 children
// beneath root-level siblings like the pane divider).
export function portal(node: HTMLElement, target: HTMLElement | string = document.body): { destroy(): void } {
  const host = typeof target === 'string' ? document.querySelector(target) : target
  if (host && host !== node.parentNode) host.appendChild(node)
  return {
    destroy() {
      node.remove()
    },
  }
}
