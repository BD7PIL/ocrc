import { useEffect, useRef } from 'react'
import {
  mountBadge, mountBanner, mountButton, mountCheckbox, mountEmpty, mountList, mountMenu, mountSelect,
  mountSeparator, mountSpinner, mountSwitch, mountTextField,
  type BadgeProps, type BannerProps, type ButtonProps, type CheckboxProps, type EmptyProps,
  type Handle, type ListProps, type MenuProps, type SelectProps, type SeparatorProps, type SpinnerProps,
  type TextFieldProps,
} from '@openchamber/sdk/ui'

/** Every kit mount has this shape: `update` merges props, `dispose` unpaints. */
type Mount<P> = (root: Element, props: P) => Handle<P>

/**
 * Bind one kit primitive to React.
 *
 * The kit is imperative by design — mount once, then push prop changes through
 * `update`, which repaints in place. That matters beyond style: rebuilding the
 * text field on every keystroke would drop the caret, and rebuilding the select
 * would close its popup. So mount happens in a `[]`-deps effect and everything
 * after it goes through `update`.
 */
function useKit<P>(mount: Mount<P>, props: P) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const handle = useRef<Handle<P> | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount once; later renders go through update
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const mounted = mount(root, props)
    handle.current = mounted
    return () => {
      handle.current = null
      mounted.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first props only; later renders use update
  }, [])

  useEffect(() => { handle.current?.update(props) })

  return ref
}

/** The kit paints the host's own components; the wrapper only has to stay out of layout. */
export function KitButton(props: ButtonProps) {
  return <span ref={useKit(mountButton, props)} className="oc-kit" />
}

export function KitBadge(props: BadgeProps) {
  return <span ref={useKit(mountBadge, props)} className="oc-kit" />
}

export function KitField(props: TextFieldProps) {
  return <span ref={useKit(mountTextField, props)} className="oc-kit" />
}

export function KitSelect(props: SelectProps) {
  return <span ref={useKit(mountSelect, props)} className="oc-kit" />
}

export function KitEmpty(props: EmptyProps) {
  return <span ref={useKit(mountEmpty, props)} className="oc-kit" />
}

export function KitSpinner(props: SpinnerProps) {
  return <span ref={useKit(mountSpinner, props)} className="oc-kit" />
}

export function KitBanner(props: BannerProps) {
  return <span ref={useKit(mountBanner, props)} className="oc-kit" />
}

export function KitCheck(props: CheckboxProps) {
  return <span ref={useKit(mountCheckbox, props)} className="oc-kit" />
}

export function KitSwitch(props: CheckboxProps) {
  return <span ref={useKit(mountSwitch, props)} className="oc-kit" />
}

export function KitSeparator(props: SeparatorProps) {
  return <span ref={useKit(mountSeparator, props)} className="oc-kit" />
}

export function KitList(props: ListProps) {
  return <span ref={useKit(mountList, props)} className="oc-kit" />
}

export function KitMenu(props: MenuProps) {
  return <span ref={useKit(mountMenu, props)} className="oc-kit" />
}

/**
 * SDK 图标（Remixicon outlines）。SDK 的 `icon()` 没有从 `@openchamber/sdk/ui`
 * 出口导出（kit 控件内部自用），这里按 `icons.js` 的原 path 复刻——同一套图标
 * 体系，不引入第二种视觉语言。颜色跟 `currentColor`（宿主令牌）。
 */
const ICON_PATHS = {
  chevron: 'M12 13.172l4.95-4.95 1.414 1.414L12 16 5.636 9.636 7.05 8.222z',
  check: 'M10 15.172l9.192-9.193 1.415 1.414L10 18l-6.364-6.364 1.414-1.414z',
  close: 'M12 10.586l4.95-4.95 1.414 1.414-4.95 4.95 4.95 4.95-1.414 1.414-4.95-4.95-4.95 4.95-1.414-1.414 4.95-4.95-4.95-4.95L7.05 5.636z',
} as const

export type KitIconName = keyof typeof ICON_PATHS

export function KitIcon({ name, size = 12 }: { name: KitIconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className="oc-icon">
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}
