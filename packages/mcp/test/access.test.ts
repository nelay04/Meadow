import { describe, expect, it } from 'vitest'

import { describeBoundaries, usable } from '../src/access'
import type { TokenInfo } from '../src/api'
import { allowedPhrase, refusal } from '../src/room'

const classic: TokenInfo = {
  id: 't1',
  name: 'laptop',
  kind: 'classic',
  expires_at: null,
  can_create_glades: true,
  grants: null,
}

const fine: TokenInfo = {
  id: 't2',
  name: 'reviewer',
  kind: 'fine_grained',
  expires_at: null,
  can_create_glades: false,
  grants: [
    { board_id: 'a', title: 'Alpha', read: true, edit: true, delete: false },
    { board_id: 'c', title: 'Charlie', read: true, edit: false, delete: true },
  ],
}

describe('describeBoundaries', () => {
  it('names every granted glade and what may be done there', () => {
    const text = describeBoundaries(fine)
    expect(text).toContain('"Alpha" (a): read and edit (no delete)')
    expect(text).toContain('"Charlie" (c): read and delete (no edit)')
    expect(text).toContain('cannot create or import glades')
  })

  it('says a classic token has the account', () => {
    expect(describeBoundaries(classic)).toContain('anything the account can do')
  })
})

describe('usable', () => {
  it('hides tools a token can use nowhere', () => {
    const readOnly: TokenInfo = {
      ...fine,
      grants: [{ board_id: 'a', title: 'A', read: true, edit: false, delete: false }],
    }
    expect(usable(readOnly, 'read')).toBe(true)
    expect(usable(readOnly, 'edit')).toBe(false)
    expect(usable(readOnly, 'delete')).toBe(false)
    expect(usable(fine, 'edit')).toBe(true)
    expect(usable(fine, 'delete')).toBe(true)
    expect(usable(fine, 'create')).toBe(false)
    expect(usable(classic, 'create')).toBe(true)
  })
})

describe('refusal', () => {
  const room = (access: Partial<Parameters<typeof refusal>[0]['access']>) => ({
    board: { title: 'Alpha' } as Parameters<typeof refusal>[0]['board'],
    access: {
      token: 'x',
      role: 'owner' as const,
      can_write: true,
      can_edit: true,
      can_delete: true,
      is_locked: false,
      ...access,
    },
  })

  it('allows what the connection may do', () => {
    expect(refusal(room({}), 'edit')).toBeNull()
    expect(refusal(room({}), 'delete')).toBeNull()
  })

  it('names the boundary that applies', () => {
    expect(refusal(room({ can_delete: false }), 'delete')).toMatch(
      /token may read and edit, but not delete/,
    )
    expect(
      refusal(
        room({ role: 'viewer', can_write: false, can_edit: false, can_delete: false }),
        'edit',
      ),
    ).toMatch(/role there is viewer/)
    expect(
      refusal(
        room({ is_locked: true, can_write: false, can_edit: false, can_delete: false }),
        'edit',
      ),
    ).toMatch(/locked/)
  })

  it('phrases permissions', () => {
    expect(allowedPhrase({ can_edit: false, can_delete: false })).toBe('only read')
  })
})
