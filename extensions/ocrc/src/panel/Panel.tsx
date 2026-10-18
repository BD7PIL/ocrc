import { useCallback, useEffect, useState } from 'react'
import type { HostClient } from '@openchamber/sdk'
import { connectThemedHost } from '../shared/host-theme.js'
import { KitBanner } from '../shared/kit.js'
import type { RequestFn } from '../shared/service-client.js'
import { RemoteInstance } from './RemoteInstance.js'

/**
 * 面板 = **远程服务器列表**，只有这一件事。
 *
 * 这里曾经并排放着上一代的三块（连接 / 远程工作区 / 配置同步）与四个标签页。
 * 它们的前提是「控制端的 openchamber 用 ssh -L 去连远程机器上裸跑的引擎」——而现在
 * 远程机器自己跑 openchamber、桌面 app 用配对链接连它，那三块要么永远停在空态、
 * 要么和这张卡片重复（同一件事两套入口）。仓库只为这一个功能服务，所以它们不在了。
 *
 * 剩下的动线只有一条：添加服务器 → 检查并安装 → 启动 → 创建配对链接。
 */
export function Panel() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let disposed = false
    try {
      const h = connectThemedHost()
      if (!disposed) setHost(h)
    } catch (e) {
      if (!disposed) setErr(e instanceof Error ? e.message : String(e))
    }
    return () => { disposed = true }
  }, [])

  const request: RequestFn = useCallback((path, method = 'GET', body) => {
    if (!host) return Promise.reject(new Error('宿主桥未就绪'))
    return host.serviceRequest({
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }, [host])

  return (
    <div className="oc-page">
      {err ? <KitBanner tone="error" title="面板没能接上宿主" body={err} /> : null}
      {/* 宿主桥就绪之前不发请求：RemoteInstance 的第一遍渲染拿不到 host，这时发请求
          只会得到「宿主桥未就绪」——正常情况下它被紧接着的成功应答盖掉，服务慢时
          却会留在屏幕上。所以"还没接上宿主"这件事由面板自己说。 */}
      {host
        ? <RemoteInstance request={request} host={host} />
        : <span className="oc-muted oc-sm">正在连接宿主…</span>}
    </div>
  )
}
