import { useEffect, useRef } from 'react'
import {
  mountBadge, mountBanner, mountButton, mountCheckbox, mountEmpty, mountList, mountSelect,
  mountSeparator, mountSpinner, mountSwitch, mountTabs, mountTextField,
  type BadgeProps, type BannerProps, type ButtonProps, type CheckboxProps, type EmptyProps,
  type Handle, type ListProps, type SelectProps, type SeparatorProps, type SpinnerProps,
  type TabsProps, type TextFieldProps,
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

export function KitTabs(props: TabsProps) {
  return <span ref={useKit(mountTabs, props)} className="oc-kit" />
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
