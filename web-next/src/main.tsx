import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './index.css'
// 非安全上下文垫片必须先于一切组件代码：手机经 http://LAN 访问时
// navigator.clipboard / crypto.randomUUID / crypto.subtle 缺失，vendor 的
// 复制按钮、遥测 id、pptx 指纹会点击即抛。见 lib/insecure-context.ts。
import { installInsecureContextShims } from './lib/insecure-context.js'

installInsecureContextShims()

// ── 输入模态感知（theme.css 焦点环全局表的另一半）──
// 键盘导航（Tab/方向键/Enter）切 keyboard；指针按下切 pointer。焦点环只在
// keyboard 模态可见（html[data-input-modality='pointer'] :focus-visible 透
// 明化）。
let lastModality: string | undefined
function setModality(m: 'keyboard' | 'pointer') {
  if (lastModality === m) return
  lastModality = m
  document.documentElement.dataset.inputModality = m
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === 'Escape') {
    setModality('keyboard')
  }
}, { capture: true })
document.addEventListener('pointerdown', () => setModality('pointer'), { capture: true })
document.documentElement.dataset.inputModality = 'pointer'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
