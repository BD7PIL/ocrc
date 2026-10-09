import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * P0-3: ATTACHED mode. When a live ocrc host owns the primary lock, the plugin
 * registers tools that call the host and owns nothing else — no listener, no
 * Telegram poller, no state, and no lock of its own.
 */
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { createAttachedHooks } from '../../src/plugin/attached.js'

const OPTS = { baseUrl: 'http://127.0.0.1:4199', resolveToken: () => 'test-token', version: '1.0.0-rc.5' }

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('createAttachedHooks', () => {
  it('registers the ocrc tool set and no event hook (owns nothing)', () => {
    const hooks = createAttachedHooks(OPTS)
    expect(Object.keys(hooks.tool!).sort()).toEqual(['notify', 'rc-status', 'schedule_create', 'schedule_list'])
    expect(hooks.event).toBeUndefined()
    expect(typeof hooks.dispose).toBe('function')
  })

  it('sends the host token on every call', async () => {
    const calls = stubFetch(() => jsonResponse({ schedules: [] }))
    const hooks = createAttachedHooks(OPTS)
    await hooks.tool!['schedule_list'].execute({}, {} as any)
    expect(calls[0].url).toBe('http://127.0.0.1:4199/api/schedules')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
  })

  it('resolves the token lazily, so a plugin that attached mid-host-startup still works', async () => {
    // The host writes its token while starting up; a plugin that attached inside
    // that window must not bake in "no token" forever.
    let token: string | undefined
    const calls = stubFetch(() => jsonResponse({ schedules: [] }))
    const hooks = createAttachedHooks({ ...OPTS, resolveToken: () => token })

    const before = await hooks.tool!['schedule_list'].execute({}, {} as any)
    expect(before).toContain('host token not readable yet')
    expect(calls).toHaveLength(0)

    token = 'late-token'
    await hooks.tool!['schedule_list'].execute({}, {} as any)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer late-token')
  })

  it('rc-status reports the HOST, not the plugin', async () => {
    stubFetch(() => jsonResponse({ version: '1.0.0-rc.5', mode: 'host', pid: 4242, webPort: 4199, telegram: { connected: true, username: 'ocrc_bot' }, uptimeSeconds: 600 }))
    const out = await createAttachedHooks(OPTS).tool!['rc-status'].execute({}, {} as any)
    expect(out).toContain('host host')
    expect(out).toContain('4242')
    expect(out).toContain(':4199')
    expect(out).toContain('@ocrc_bot')
  })

  it('notify posts the message and the calling session to the host', async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true }))
    const out = await createAttachedHooks(OPTS).tool!.notify.execute({ message: 'tests are green' }, { sessionID: 'ses_1' } as any)
    expect(out).toBe('notification sent')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ message: 'tests are green', sessionId: 'ses_1' })
  })

  it('schedule_create validates locally, then posts a spec the host accepts', async () => {
    const calls = stubFetch(() => jsonResponse({ schedule: { id: 'sch_9' } }))
    const hooks = createAttachedHooks(OPTS)

    expect(await hooks.tool!['schedule_create'].execute({ prompt: '' }, {} as any)).toBe('schedule_create failed: prompt is required')
    expect(await hooks.tool!['schedule_create'].execute({ prompt: 'x', every_minutes: 5, daily_time: '09:00' }, {} as any))
      .toBe('schedule_create failed: provide every_minutes OR daily_time, not both')
    expect(await hooks.tool!['schedule_create'].execute({ prompt: 'x', daily_time: '25:00' }, {} as any))
      .toBe('schedule_create failed: daily_time must be HH:MM, got "25:00"')
    expect(calls).toHaveLength(0) // nothing reached the host on a bad argument

    const ok = await hooks.tool!['schedule_create'].execute({ prompt: '每天巡检', daily_time: '9:00', title: '巡检' }, {} as any)
    expect(ok).toBe('定时任务已创建（sch_9）— 每天 09:00执行：每天巡检。管理：Web 面板右栏 → 定时任务。')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      name: '巡检', prompt: '每天巡检', spec: { kind: 'daily', time: '09:00' }, enabled: true,
    })
  })

  it('schedule_list formats like the full-mode tool', async () => {
    stubFetch(() => jsonResponse({ schedules: [
      { id: 'a', name: '巡检', prompt: 'p', spec: { kind: 'every', minutes: 30 }, enabled: true, createdAt: 1 },
      { id: 'b', name: '', prompt: 'q', spec: { kind: 'daily', time: '09:00' }, enabled: false, createdAt: 2 },
    ] }))
    const out = await createAttachedHooks(OPTS).tool!['schedule_list'].execute({}, {} as any)
    expect(out).toBe('#a 巡检 — 每 30 分钟 — p\n#b — 每天 09:00（已暂停） — q')
  })

  it('returns an empty-list sentence rather than an empty string', async () => {
    stubFetch(() => jsonResponse({ schedules: [] }))
    expect(await createAttachedHooks(OPTS).tool!['schedule_list'].execute({}, {} as any)).toBe('（当前没有定时任务）')
  })

  it('a dead host reads as a tool failure, never a throw', async () => {
    stubFetch(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:4199') })
    const out = await createAttachedHooks(OPTS).tool!.notify.execute({ message: 'x' }, {} as any)
    expect(out).toContain('notify failed: ocrc host unreachable at http://127.0.0.1:4199')
    expect(out).toContain('ECONNREFUSED')
  })

  it('surfaces a non-2xx host response as a tool failure', async () => {
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401))
    const out = await createAttachedHooks(OPTS).tool!['schedule_list'].execute({}, {} as any)
    expect(out).toContain('schedule_list failed')
    expect(out).toContain('401')
  })

  it('exposes the wf_echo probe only when asked, and reports the HOST-assigned run id', async () => {
    expect(createAttachedHooks(OPTS).tool!.wf_echo).toBeUndefined()

    stubFetch(() => jsonResponse({ ok: true, value: 'ping', runId: 'host-4242-1', hostPid: 4242 }))
    const out = await createAttachedHooks({ ...OPTS, probe: true }).tool!.wf_echo.execute({ value: 'ping' }, {} as any)
    expect(out).toBe('wf_echo ok: value=ping runId=host-4242-1 hostPid=4242')
  })

  it('dispose tears down nothing (the host owns every resource)', async () => {
    const hooks = createAttachedHooks(OPTS)
    await expect(hooks.dispose()).resolves.toBeUndefined()
  })
})
