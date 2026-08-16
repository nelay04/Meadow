import { describe, expect, it } from 'vitest'

import {
  MAX_VISIBLE,
  type Toast,
  dismissToast,
  pushToast,
  removeToast,
} from './toastStore'

const push = (list: readonly Toast[], message: string, kind: Toast['kind'] = 'info'): Toast[] =>
  pushToast(list, { kind, message })

describe('toast store', () => {
  it('appends, so the newest sits nearest the corner', () => {
    const list = push(push([], 'first'), 'second')
    expect(list.map((toast) => toast.message)).toEqual(['first', 'second'])
  })

  it('gives each kind its own lifetime', () => {
    const [info] = push([], 'a', 'info')
    const [error] = push([], 'a', 'error')
    expect(error.life).toBeGreaterThan(info.life)
  })

  it('restarts a duplicate rather than stacking it', () => {
    // The case this exists for: a refusal fired from a pointer handler, once a frame.
    let list: Toast[] = []
    for (let i = 0; i < 40; i += 1) list = push(list, 'Read only.', 'error')

    expect(list).toHaveLength(1)
    expect(list[0].count).toBe(40)
    // Bumped every time, because the progress bar is keyed on it and that is the only
    // way the CSS animation starts over.
    expect(list[0].seq).toBe(39)
  })

  it('treats the same words from a different kind as a different message', () => {
    const list = push(push([], 'Saved', 'success'), 'Saved', 'error')
    expect(list).toHaveLength(2)
  })

  it('does not revive a toast that is already leaving', () => {
    const first = push([], 'Gone')
    const leaving = dismissToast(first, first[0].id)
    const list = push(leaving, 'Gone')

    expect(list).toHaveLength(2)
    expect(list[0].leaving).toBe(true)
    expect(list[1].leaving).toBeUndefined()
  })

  it('evicts the oldest once the stack is full', () => {
    let list: Toast[] = []
    for (let i = 0; i < MAX_VISIBLE + 2; i += 1) list = push(list, `m${i}`)

    const live = list.filter((toast) => toast.leaving !== true)
    expect(live).toHaveLength(MAX_VISIBLE)
    expect(live[0].message).toBe('m2')
    expect(list.filter((toast) => toast.leaving === true).map((t) => t.message)).toEqual([
      'm0',
      'm1',
    ])
  })

  it('counts only live toasts against the cap', () => {
    // A burst arriving while old ones animate out must not evict the new ones. The
    // leaving toasts are about to free their own slots.
    let list: Toast[] = []
    for (let i = 0; i < MAX_VISIBLE; i += 1) list = push(list, `old${i}`)
    list = list.map((toast) => ({ ...toast, leaving: true }))

    list = push(list, 'new')

    expect(list.find((toast) => toast.message === 'new')?.leaving).toBeUndefined()
  })

  it('marks on dismiss and drops on remove', () => {
    const list = push([], 'x')
    const id = list[0].id

    expect(dismissToast(list, id)[0].leaving).toBe(true)
    expect(removeToast(list, id)).toEqual([])
  })
})
