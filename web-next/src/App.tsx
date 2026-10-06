// M0 boot surface — a live token gallery. It doubles as the CDP self-check
// target: theme contract, three-layer tokens, ZCode font ladder, dsh global
// sheets (corner-shape / scrollbar / modality-aware focus) and the hairline
// elevation trio are all visible and assertable here. The real shell lands in
// M1 (WorkspaceShellLayout register).
import { useState, type ReactNode } from 'react'

type ThemeChoice = 'auto' | 'light' | 'dark'
const ORDER: ThemeChoice[] = ['auto', 'light', 'dark']

function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem('ocrc-theme')
    return t === 'light' || t === 'dark' ? t : 'auto'
  } catch {
    return 'auto'
  }
}

function applyTheme(t: ThemeChoice) {
  try {
    if (t === 'auto') localStorage.removeItem('ocrc-theme')
    else localStorage.setItem('ocrc-theme', t)
  } catch { /* private mode */ }
  if (t === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', t)
}

const cornerShapeOk = typeof CSS !== 'undefined' && CSS.supports?.('corner-shape: superellipse(1.5)')

export default function App() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!
    setTheme(next)
    applyTheme(next)
  }

  return (
    <div className="h-full overflow-y-auto">
      <header
        className="sticky top-0 flex items-center gap-3 border-b px-5 py-3"
        style={{ background: 'var(--bg-panel)', borderColor: 'var(--border)' }}
      >
        <span
          className="inline-block size-3.5 rounded-full"
          style={{ background: 'var(--accent)' }}
          aria-hidden
        />
        <span className="font-medium" style={{ fontSize: 'var(--ui-lg)' }}>ocrc</span>
        <span
          className="mono rounded-full px-2 py-0.5"
          style={{
            fontSize: 'var(--ui-2xs)',
            color: 'var(--text-3)',
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
          }}
        >
          0.27.0-alpha · M0
        </span>
        <span className="label hidden sm:inline">ZCode 平替驾驶舱 · 地基</span>
        <button
          type="button"
          onClick={cycle}
          className="ml-auto rounded-lg px-3 py-1.5 transition-colors"
          style={{
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            color: 'var(--text-2)',
            fontSize: 'var(--ui-sm)',
          }}
        >
          主题：{theme === 'auto' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}
        </button>
      </header>

      <main className="mx-auto grid max-w-5xl grid-cols-1 gap-5 p-5 md:grid-cols-2">
        <Card title="字阶 — ZCode 相对阶梯（--ui-font-size 14px 基准）">
          <LadderRow name="ui-xl" px="+4" sample="驾驶舱" />
          <LadderRow name="ui-lg" px="+2" sample="会话标题" />
          <LadderRow name="ui-base" px="14" sample="正文：远程驾驶你自己的 opencode。" />
          <LadderRow name="ui-caption" px="-1" sample="次级说明文本" />
          <LadderRow name="ui-sm" px="-2" sample="chip / 控件文本" />
          <LadderRow name="ui-xs" px="-4" sample="快捷键提示 Ctrl+K" />
          <LadderRow name="ui-2xs" px="-5" sample="LABEL 徽标" mono />
        </Card>

        <Card title="语义色 — 冻结层（static 直通）">
          <div className="flex flex-wrap gap-2">
            <Swatch name="accent" v="var(--accent)" />
            <Swatch name="ok" v="var(--ok)" />
            <Swatch name="warn" v="var(--warn)" />
            <Swatch name="err" v="var(--err)" />
            <Swatch name="info" v="var(--info)" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Swatch name="role-gold" v="var(--role-gold)" />
            <Swatch name="role-blue" v="var(--role-blue)" />
            <Swatch name="role-green" v="var(--role-green)" />
            <Swatch name="role-silver" v="var(--role-silver)" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Swatch name="hl-purple" v="var(--hl-purple)" />
            <Swatch name="hl-green" v="var(--hl-green)" />
            <Swatch name="hl-cyan" v="var(--hl-cyan)" />
            <Swatch name="hl-orange" v="var(--hl-orange)" />
          </div>
        </Card>

        <Card title="dsh 发丝高程三件套（0.5px 描边 + 双层柔光）">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ElevBox token="var(--elev-soft)" name="soft" />
            <ElevBox token="var(--elev-panel)" name="panel" />
            <ElevBox token="var(--elev-prominent)" name="prominent" />
          </div>
        </Card>

        <Card title={`圆角 + corner-shape（${cornerShapeOk ? 'superellipse 已启用' : '引擎回落普通圆角'}）`}>
          <div className="flex flex-wrap items-end gap-3">
            <RadiusBox r="var(--radius)" label="14" />
            <RadiusBox r="var(--radius-sm)" label="9" />
            <RadiusBox r="var(--radius-xs)" label="6" />
            <RadiusBox r="var(--radius-pill)" label="pill" wide />
          </div>
          <p className="mt-3" style={{ fontSize: 'var(--ui-caption)', color: 'var(--text-3)' }}>
            superellipse(1.5) 渐进增强：支持的引擎全部圆角获得连续曲率。
          </p>
        </Card>

        <Card title="滚动条皮肤（双路径引擎门控）">
          <div
            className="h-32 overflow-y-auto rounded-lg p-3"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
          >
            {Array.from({ length: 14 }, (_, i) => (
              <p key={i} className="mono" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
                line {String(i + 1).padStart(2, '0')} — scroll me（悬停拇指变色）
              </p>
            ))}
          </div>
        </Card>

        <Card title="焦点环 — 输入模态感知（键盘 Tab 才亮，鼠标点击不亮）">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="demo-btn">键盘试试 Tab</button>
            <button type="button" className="demo-btn">按钮乙</button>
            <button type="button" className="demo-btn accent">accent</button>
          </div>
          <p className="mt-3" style={{ fontSize: 'var(--ui-caption)', color: 'var(--text-3)' }}>
            modality = <code className="mono">{typeof document !== 'undefined' ? document.documentElement.dataset.inputModality : '—'}</code>
            （点页面任意处后变 pointer，按 Tab 变 keyboard）
          </p>
        </Card>
      </main>

      <footer className="px-5 pb-8 text-center" style={{ color: 'var(--text-3)' }}>
        <p style={{ fontSize: 'var(--ui-caption)' }}>
          web-next M0 · 搬运层（ws/api/auth/sanitize/ansi/nav + 9 测试）已迁移 zustand/vitest ·
          <a href="/" className="ml-1 underline" style={{ color: 'var(--accent)' }}>返回旧壳</a>
        </p>
      </footer>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className="rounded-[14px] p-4"
      style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}
    >
      <h2 className="label mb-3">{title}</h2>
      {children}
    </section>
  )
}

function LadderRow({ name, px, sample, mono }: { name: string; px: string; sample: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="mono w-24 shrink-0" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>
        --{name} ({px})
      </span>
      <span
        className={mono ? 'mono' : undefined}
        style={{ fontSize: `var(--${name})`, color: 'var(--text)' }}
      >
        {sample}
      </span>
    </div>
  )
}

function Swatch({ name, v }: { name: string; v: string }) {
  return (
    <span
      className="mono inline-flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5"
      style={{ border: '1px solid var(--border)', background: 'var(--bg-input)', fontSize: 'var(--ui-2xs)', color: 'var(--text-2)' }}
    >
      <span className="inline-block size-3 rounded-full" style={{ background: v }} aria-hidden />
      {name}
    </span>
  )
}

function ElevBox({ token, name }: { token: string; name: string }) {
  return (
    <div
      className="flex h-20 items-center justify-center rounded-[14px]"
      style={{ background: 'var(--bg)', boxShadow: token }}
    >
      <span className="mono" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-3)' }}>--elev-{name}</span>
    </div>
  )
}

function RadiusBox({ r, label, wide }: { r: string; label: string; wide?: boolean }) {
  return (
    <div
      className={`flex h-14 items-center justify-center ${wide ? 'w-28' : 'w-14'}`}
      style={{ borderRadius: r, background: 'var(--accent-2)', border: '1px solid var(--accent-line)' }}
    >
      <span className="mono" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-2)' }}>{label}</span>
    </div>
  )
}
