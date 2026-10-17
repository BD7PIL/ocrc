import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Vitest runs without globals here, so Testing Library cannot register its own
// auto-cleanup. Without this every render from an earlier test stays mounted and
// queries start matching two panels.
afterEach(() => { cleanup() })
