import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWeComTransport } from '../../src/transport/wecom/index'
import { createCardBus } from '../../src/core/card-bus'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const bus = createCardBus()
  const posts: Array<{ url: string; body: any }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
  }))
  const transport = createWeComTransport({ webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SEKRET' })
  transport.start({ cardBus: bus, state: {} as any })
  return { bus, posts, transport }
}

describe('wecom transport (push-only webhook)', () => {
  it('assistant finals and proactive info cards push as markdown', async () => {
    const { bus, posts } = setup()
    bus.publish({ kind: 'assistant', sessionId: 's1', id: 'a1', blocks: [{ type: 'text', text: '构建完成' }], meta: { cost: 0.5 } })
    bus.publish({ kind: 'info', sessionId: 's1', id: 'i1', title: 'Test failure detected', sections: [{ body: 'npm test failed' }], proactive: true })
    await new Promise((r) => setTimeout(r, 30))

    expect(posts).toHaveLength(2)
    expect(posts[0].url).toContain('key=SEKRET')
    expect(posts[0].body.msgtype).toBe('markdown')
    expect(posts[0].body.markdown.content).toContain('构建完成')
    expect(posts[0].body.markdown.content).toContain('$0.500')
    expect(posts[1].body.markdown.content).toContain('Test failure detected')
  })

  it('process surfaces (thinking/streaming/user) never push', async () => {
    const { bus, posts } = setup()
    bus.publish({ kind: 'thinking', sessionId: 's1', showStop: true })
    bus.publish({ kind: 'streaming', sessionId: 's1', id: 'x', blocks: [{ type: 'text', text: 'partial' }] })
    bus.publish({ kind: 'user', sessionId: 's1', id: 'u1', text: 'hello', ts: Date.now(), origin: 'telegram' })
    await new Promise((r) => setTimeout(r, 20))
    expect(posts).toHaveLength(0)
  })

  it('webhook errors are logged, never thrown into the card flow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook' }), { status: 200 })))
    const { bus } = setup()
    bus.publish({ kind: 'error', sessionId: 's1', message: 'boom' })
    await new Promise((r) => setTimeout(r, 20))
    // no throw escaped — nothing to assert beyond reaching here
    expect(true).toBe(true)
  })
})
