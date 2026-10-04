import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelsStore } from '../../src/core/channels'

function tmpPath() {
  return join(mkdtempSync(join(tmpdir(), 'ocrc-chan-')), 'channels.json')
}

describe('createChannelsStore', () => {
  it('seeds three channel defaults with only telegram enabled', () => {
    const store = createChannelsStore(tmpPath())
    const bots = store.list()
    expect(bots.map((b) => b.id)).toEqual(['tg-default', 'wechat-default', 'lark-default'])
    expect(bots.find((b) => b.id === 'tg-default')?.enabled).toBe(true)
    expect(bots.find((b) => b.id === 'wechat-default')?.enabled).toBe(false)
    expect(bots.find((b) => b.id === 'tg-default')?.replyGranularity).toBe('standard')
  })

  it('update() persists per-channel settings; a fresh store sees them', async () => {
    const path = tmpPath()
    const store = createChannelsStore(path)
    const updated = store.update('tg-default', {
      replyGranularity: 'detailed',
      workspaces: { mode: 'custom', dirs: ['/home/u/proj'] },
      credentials: { token: '123:abc' },
    })
    expect(updated?.replyGranularity).toBe('detailed')

    // persistence is 100ms-debounced — let the write land before reloading
    await new Promise((r) => setTimeout(r, 150))
    const again = createChannelsStore(path)
    const tg = again.get('tg-default')!
    expect(tg.replyGranularity).toBe('detailed')
    expect(tg.workspaces).toEqual({ mode: 'custom', dirs: ['/home/u/proj'] })
    expect(tg.credentials.token).toBe('123:abc')
    // untouched channels stay at defaults
    expect(again.get('wechat-default')?.replyGranularity).toBe('standard')
  })

  it('reset() returns a channel to its defaults (entries never disappear)', () => {
    const store = createChannelsStore(tmpPath())
    store.update('tg-default', { enabled: false, replyGranularity: 'detailed' })
    expect(store.get('tg-default')?.enabled).toBe(false)

    const fresh = store.reset('tg-default')!
    expect(fresh.enabled).toBe(true)
    expect(fresh.replyGranularity).toBe('standard')
    expect(store.list()).toHaveLength(3)
  })

  it('update()/reset() on an unknown id returns undefined', () => {
    const store = createChannelsStore(tmpPath())
    expect(store.update('nope', { enabled: false })).toBeUndefined()
    expect(store.reset('nope')).toBeUndefined()
  })
})
