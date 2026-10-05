import { describe, it, expect, afterEach, vi } from 'vitest'

const ctorCalls: string[] = []
vi.mock('undici', () => ({
  ProxyAgent: class {
    dispatcher = undefined
    constructor(opts: string | { uri: string }) {
      ctorCalls.push(typeof opts === 'string' ? opts : opts.uri)
    }
  },
}))

import { buildTelegramFetchConfig } from '../../../src/transport/telegram/proxy'

afterEach(() => {
  delete process.env.TELEGRAM_PROXY
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  ctorCalls.length = 0
})

describe('buildTelegramFetchConfig', () => {
  it('returns undefined when no proxy env is set', () => {
    expect(buildTelegramFetchConfig()).toBeUndefined()
    expect(ctorCalls).toEqual([])
  })

  it('wraps TELEGRAM_PROXY into a ProxyAgent dispatcher', () => {
    process.env.TELEGRAM_PROXY = 'http://proxy.corp.lan:8080'
    const cfg = buildTelegramFetchConfig()
    expect(cfg).toBeDefined()
    expect(ctorCalls).toEqual(['http://proxy.corp.lan:8080'])
  })

  it('prefers TELEGRAM_PROXY over HTTPS_PROXY', () => {
    process.env.TELEGRAM_PROXY = 'http://tg-specific:3128'
    process.env.HTTPS_PROXY = 'http://machine-wide:3128'
    buildTelegramFetchConfig()
    expect(ctorCalls).toEqual(['http://tg-specific:3128'])
  })

  it('falls back to HTTPS_PROXY / https_proxy', () => {
    process.env.HTTPS_PROXY = 'http://fallback-a:1'
    buildTelegramFetchConfig()
    delete process.env.HTTPS_PROXY
    process.env.https_proxy = 'http://fallback-b:2'
    buildTelegramFetchConfig()
    expect(ctorCalls).toEqual(['http://fallback-a:1', 'http://fallback-b:2'])
  })
})
