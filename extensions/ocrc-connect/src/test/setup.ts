import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Vitest runs without globals here, so Testing Library cannot register its own
// auto-cleanup. Without this every render from an earlier test stays mounted and
// queries start matching two panels.
afterEach(() => { cleanup() })

// jsdom ships neither a layout engine nor ResizeObserver. The work-status
// section sizes its frame from the content it measured, so both gaps have to be
// filled for that path to be observable at all: measurements come back as a
// fixed box, and the observer is a no-op the test can still assert was used.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() { /* jsdom has nothing to observe */ }
    unobserve() { /* nothing to release */ }
    disconnect() { /* nothing to release */ }
  } as unknown as typeof ResizeObserver
}

const BOX = { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 40, width: 400, height: 40 }
Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { ...BOX, toJSON: () => BOX }
} as typeof Element.prototype.getBoundingClientRect
