// lib/insecure-context.ts — 非安全上下文（http://LAN）能力垫片，ocrc 唯一入口。
//
// 为什么存在：手机经局域网 http 访问 /z/（http://192.168.x.x:4199）时，浏览器
// 不暴露任何要求安全上下文的 API——`navigator.clipboard` 整个 undefined、
// `crypto.randomUUID` / `crypto.subtle` 缺失。vendor 有 12 个文件的复制按钮、
// 7 处 randomUUID、1 处 pptx 指纹 digest 直接调用它们（盘点见
// docs/frontend-mobile-audit.md §4-C4），不垫片就是点击即抛 TypeError 或静默
// 无反应。这里在 bootstrap 最早时机把缺失的 API 以回退实现补齐到全局，
// vendor/ocrc 全部调用点自动受益——零 vendor 改动（PATCHES 口径：ocrc 侧覆盖）。
//
// 回退实现（有原生 API 时一个字节都不动）：
//  - clipboard.writeText → 隐藏 textarea + execCommand('copy')（需用户手势，
//    复制按钮的点击链路天然满足）；失败则 reject，让调用方的 catch/成功分支
//    如常工作。
//  - crypto.randomUUID → crypto.getRandomValues 拼 RFC 4122 v4（getRandomValues
//    在非安全上下文仍然可用）；再没有才落到 Math.random（并标注）。
//  - crypto.subtle.digest → 仅 SHA-256 回退到 vendor 的纯 JS 实现
//    （@zcode/ui/v4/sha256Pure.js，PATCHES #4 的同一份，FIPS 180-4）；
//    其它算法显式 reject（与原生行为一致：不支持的算法本来就会抛）。
//  - Notification / getUserMedia / 拍照 capture：不做（PRODUCT 无对应功能，
//    审计 6.4 明确不做）。

type Sha256Input = ArrayBuffer | ArrayBufferView

function defineGetter(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, configurable: true, writable: true })
  } catch {
    /* 极端锁定环境（旧 WebView 只读原型）——垫片装不上就维持原状 */
  }
}

function fallbackWriteText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // execCommand('copy') 只在用户手势的同步调用栈里生效——不能 await 后再调。
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    // 移到视口内但不可见：iOS 上 display:none / 视口外的选区会复制失败。
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.padding = '0'
    textarea.style.border = 'none'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    try {
      textarea.focus()
      textarea.select()
      textarea.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      if (ok) resolve()
      else reject(new DOMException('copy command rejected', 'NotAllowedError'))
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    } finally {
      textarea.remove()
    }
  })
}

function fallbackRandomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  const c = globalThis.crypto
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    // RFC 4122 v4：置 version 与 variant 位。
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
  }
  // 没有 getRandomValues 的环境连非安全上下文都算不上（ES2017+ 全都有）——
  // 兜底只为不抛异常，唯一性弱化如实标注。
  const hex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-a${hex().slice(1, 4)}-${hex()}${hex().slice(0, 4)}` as `${string}-${string}-${string}-${string}-${string}`
}

async function fallbackDigest(algorithm: AlgorithmIdentifier, data: Sha256Input): Promise<ArrayBuffer> {
  const name = typeof algorithm === 'string' ? algorithm : algorithm?.name
  if (!name || name.replace(/[^A-Za-z0-9]/g, '').toUpperCase() !== 'SHA256') {
    // 与原生 WebCrypto 语义一致：本回退只实现 SHA-256，其余算法明确不支持。
    throw new DOMException(`insecure-context shim only implements SHA-256, got ${String(name)}`, 'NotSupportedError')
  }
  // ArrayBuffer.isView 跨 realm 可靠（instanceof 在 vitest/jsdom 混合 realm 下会失配，
  // 把 ArrayBuffer 误判成 view 后取 .buffer 得到 undefined → 静默哈希空串）。
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
    : new Uint8Array(data as ArrayBuffer)
  const { sha256Hex } = await import('@zcode/ui/v4/sha256Pure.js')
  const hex = sha256Hex(bytes)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out.buffer
}

export function installInsecureContextShims(): void {
  if (typeof window === 'undefined') return

  // 1) clipboard：writeText 缺失时补一个回退实现；readText 保持拒绝（回退
  //    无法诚实实现读取，宁可显式失败也不假装成功）。
  if (!navigator.clipboard?.writeText) {
    defineGetter(navigator, 'clipboard', {
      writeText: (text: string) => fallbackWriteText(text),
      readText: () => Promise.reject(new DOMException('clipboard read unavailable on insecure context', 'NotAllowedError')),
    })
  }

  // 2) crypto.randomUUID：v4 回退。
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    defineGetter(crypto, 'randomUUID', () => fallbackRandomUUID())
  }

  // 3) crypto.subtle.digest：整个 subtle 缺失时补一个只含 digest 的对象。
  //    subtle 存在但个别算法缺失的情况不需要管——WebCrypto 按算法报错。
  if (typeof crypto !== 'undefined' && !crypto.subtle) {
    defineGetter(crypto, 'subtle', { digest: fallbackDigest })
  }
}
