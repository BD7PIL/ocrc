import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// base '/next/': during migration the host serves this build at :4099/next/
// while the frozen Svelte shell stays at '/'. M4 swaps the roots.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/next/',
  // vendor 树带 worker 使用（pdfjs/xterm 等）；代码分割构建必须 es 格式
  worker: { format: 'es' },
  // 我们的 tsconfig 开了 verbatimModuleSyntax（tsc 类型检查用）；但 esbuild
  // 构建必须关掉它——vendor 源里有个别混合导入把 interface 写在值位置
  // （如 rpc/proxy-channel.ts 的 IDisposable），逐字保留会在运行时导入类型。
  esbuild: { tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } } },
  resolve: {
    alias: [
      // Keep the Svelte app's '$lib' import shape so framework-free modules
      // migrate verbatim (no import rewrites, tests included).
      { find: '$lib', replacement: fileURLToPath(new URL('./src/lib', import.meta.url)) },
      // Shared card/session types live in the HOST core (same source of
      // truth as the Svelte shell's $shared alias — svelte.config.js).
      { find: '$shared', replacement: fileURLToPath(new URL('../src/core', import.meta.url)) },
      // ── N0 vendored ZCode source (Apache-2.0; see vendor/zcode/) ──
      // workspace 包全是 source exports + 子路径导入 → 前缀正则别名。
      { find: /^@zcode\/ui\/(.*)$/, replacement: fileURLToPath(new URL('./vendor/zcode/ui/src/$1', import.meta.url)) },
      { find: /^@zcode\/ui$/, replacement: fileURLToPath(new URL('./vendor/zcode/ui/src/index.ts', import.meta.url)) },
      { find: /^@zcode\/shared\/(.*)$/, replacement: fileURLToPath(new URL('./vendor/zcode/shared/src/$1', import.meta.url)) },
      { find: /^@zcode\/shared$/, replacement: fileURLToPath(new URL('./vendor/zcode/shared/src/index.ts', import.meta.url)) },
      { find: /^@zcode\/services\/(.*)$/, replacement: fileURLToPath(new URL('./vendor/zcode/services/src/$1', import.meta.url)) },
      { find: /^@zcode\/services$/, replacement: fileURLToPath(new URL('./vendor/zcode/services/src/index.ts', import.meta.url)) },
      { find: /^@zcode\/provider\/(.*)$/, replacement: fileURLToPath(new URL('./vendor/zcode/provider/src/$1', import.meta.url)) },
      { find: /^@zcode\/provider$/, replacement: fileURLToPath(new URL('./vendor/zcode/provider/src/index.ts', import.meta.url)) },
      { find: /^@zcode\/rpc\/(.*)$/, replacement: fileURLToPath(new URL('./vendor/zcode/rpc/src/$1', import.meta.url)) },
      { find: /^@zcode\/rpc$/, replacement: fileURLToPath(new URL('./vendor/zcode/rpc/src/index.ts', import.meta.url)) },
      { find: /^@zcode\/model-option-map\/(.*)$/, replacement: fileURLToPath(new URL('./vendor/zcode/model-option-map/src/$1', import.meta.url)) },
      { find: /^@zcode\/model-option-map$/, replacement: fileURLToPath(new URL('./vendor/zcode/model-option-map/src/index.ts', import.meta.url)) },
      // CUA 权限代理（opt-in 特性）：预构建包，exports 有改名映射 → 逐条别名
      { find: /^@zcode\/zcode-cua\/frame\-contract$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/frame-contract.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/host\-display\-contract$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/host-display-contract.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/request\-access\-contract$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/request-access-contract.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/pip\-session$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/pip-session.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/pip\-session\/node$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/pip-session-node.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/broker$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/broker.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/broker\/server$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/broker-server.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/broker\/ports$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/broker-ports.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/broker\/socketPath$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/broker-socket-path.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/broker\/helperConstants$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/broker-helper-constants.js', import.meta.url)) },
      { find: /^@zcode\/zcode-cua\/broker\/helperHealth$/, replacement: fileURLToPath(new URL('./vendor/zcode/cua/broker-helper-health.js', import.meta.url)) },
      // ui 包内部用 '@/' 指自身 src（其 tsconfig paths）。
      { find: /^@\/(.*)/, replacement: fileURLToPath(new URL('./vendor/zcode/ui/src/$1', import.meta.url)) },
    ],
  },
  server: {
    port: 5175,
    proxy: {
      // Dev against the running debug host (:4099). Never point at the
      // user's engine (:4096) — zero test traffic through production.
      '/api': { target: 'http://127.0.0.1:4099', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4099', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    css: false,
  },
})
