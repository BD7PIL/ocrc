import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route every test-process write (logger, token persistence, election lock)
// into a per-worker temp home so tests never touch the real ~/.ocrc.
process.env.OCRC_HOME ??= mkdtempSync(join(tmpdir(), 'ocrc-test-home-'))
