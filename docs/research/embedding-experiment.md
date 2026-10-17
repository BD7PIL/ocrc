# 内嵌试验：扩展页面能否直接显示对端 openchamber

- **日期**：2026-10-17
- **问题**：装好对端实例后，能否在 `ocrc-remote` 扩展的 page/panel 里直接 iframe
  `http://127.0.0.1:<localPort>`，把对端 UI 嵌进 openchamber，省掉「去桌面版 Remote Instances
  填三个字段」这一步？
- **结论**：**不能。** 两层独立阻断，且都不是我们能通过配置绕过的。回退到桌面版原生
  Remote Instances（已实测可用）；扩展页面只负责「装好 + 给出三项 + 用 `host.openUrl` 开浏览器」。

## 证据（运行中的 openchamber 2.3.3，本机 :3000）

### 1. guest 文档的 CSP 不允许 frame 外部地址

```
$ curl -b <登录 cookie> -D - -o /dev/null \
    http://127.0.0.1:3000/api/guests/ocrc-remote/panel/index.html
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' 'self' data: blob:;
  style-src ...; img-src ...; font-src ...; media-src ...; worker-src ...;
  frame-src 'self' data: blob:;
  connect-src 127.0.0.1:3000/api/guests/ocrc-remote/;
  object-src 'none'; form-action 'none'
```

- `frame-src` 只有 `'self' data: blob:`，**没有** `http://127.0.0.1:4610`，也没有远端 origin。
- `connect-src` 只放行该 guest 自己的 service 路由；直接 `fetch` 对端地址同样被拦。
- 对照 SDK：`contributes.origins` 只把 https origin 加进 fetch/img/font/style/media，
  **从不加进 `frame-src`/`script-src`/`worker-src`**（`@openchamber/sdk` manifest 文档原文）。

### 2. 即使绕过 guest CSP，对端也会拒绝被嵌

```
$ curl -D - -o /dev/null http://127.0.0.1:4610/
Content-Security-Policy: frame-ancestors 'self' openchamber-ui://app capacitor://localhost https://localhost
```

guest 的 sandbox 是 `sandbox allow-scripts`（没有 `allow-same-origin`），它的 origin 是
opaque `null`；不在 `frame-ancestors` 白名单里，浏览器会在握手阶段拒绝。

### 3. `window.open` 也不可用

同一个 sandbox 没有 `allow-popups`。当前 `RemoteInstance.tsx` 的「打开界面」用的是
`window.open(reply.url, '_blank', 'noopener')`，在 guest 里会被拦。应改用 SDK 的
`host.openUrl(url)`（host 代开系统浏览器），这是官方 API（`@openchamber/sdk` `host.d.ts`）。

### 4. `service.surface` 不是 DOM 内嵌

`contributes.service.surface` 是宿主画的 canvas：宿主用 `GET /surface/frame` 取帧、把输入
回传给 service。它能显示**像素流**，但要真承载一个可交互的 openchamber UI，等于自己实现
一套 VNC/远程渲染；不是「把页面嵌进来」的替代方案。v1 不做。

## 决定

1. 不做 iframe/page 内嵌，不再投入。
2. 产品 UX 走桌面版原生 **Remote Instances**：扩展装好实例后展示「地址 / 密码 / 端口」+
   复制按钮；用户在桌面版填一次，之后多机切换都是原生能力。
3. 扩展页面的「打开」按钮改用 `host.openUrl`（系统浏览器），作为不想进桌面版时的次入口。
4. 该结论写进 `docs/OPS.md` 的桌面版接入段与 `docs/PRODUCT.md` 第零点十条。

## 复现

1. 用 web UI 密码登录 `:3000`（密码不落文档）。
2. `curl -b <cookie> -D - -o /dev/null http://127.0.0.1:3000/api/guests/ocrc-remote/panel/index.html`
   看 guest CSP。
3. `curl -D - -o /dev/null http://127.0.0.1:4610/` 看对端 `frame-ancestors`。
