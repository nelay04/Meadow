/**
 * The wording of the assistant activity panel.
 *
 * The cases here are the ways a list like this goes quietly wrong: a count that reads
 * "1 objects", a tool added to the MCP server later that arrives as a blank row, and a
 * duration that says "1000ms" where it meant a second. None of those would fail
 * anything; they would just make the record look careless, which for an audit trail is
 * most of the problem.
 */

import { describe as group, expect, it } from 'vitest'

import type { McpEvent } from '../../lib/api'
import { asked, describe, took, when } from './assistantActivity'

function event(extra: Partial<McpEvent> = {}): McpEvent {
  return {
    id: 'row-1',
    operation_id: 'op-1',
    board_id: 'glade-1',
    user_id: 'user-1',
    api_token_id: 'token-1',
    tool: 'create_nodes',
    requested: 3,
    accepted: 3,
    duration_ms: 40,
    outcome: 'applied',
    reason: null,
    created_at: new Date().toISOString(),
    ...extra,
  }
}

group('what a row says happened', () => {
  it('names the tool as something a person would say', () => {
    expect(describe(event())).toBe('Added 3 objects')
    expect(describe(event({ tool: 'delete_objects', accepted: 2 }))).toBe('Removed 2 objects')
    expect(describe(event({ tool: 'tidy_layout', accepted: 9 }))).toBe(
      'Tidied the layout, 9 objects',
    )
  })

  it('counts one object as one object', () => {
    expect(describe(event({ accepted: 1 }))).toBe('Added 1 object')
    expect(describe(event({ tool: 'connect', accepted: 1 }))).toBe('Drew an arrow')
    expect(describe(event({ tool: 'connect', accepted: 4 }))).toBe('Drew 4 arrows')
  })

  it('still reads as a sentence for a tool it has never heard of', () => {
    // A tool added to the MCP server later must not arrive here as a blank row. This is
    // the case that rots: nothing else in the app would notice.
    const line = describe(event({ tool: 'rearrange_everything', accepted: 2 }))
    expect(line).toContain('rearrange everything')
    expect(line).toContain('2 objects')
  })
})

group('when it happened', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('reads as a short phrase while that is useful', () => {
    expect(when(ago(5_000))).toBe('just now')
    expect(when(ago(14 * 60_000))).toBe('14 minutes ago')
    expect(when(ago(60_000))).toBe('1 minute ago')
    expect(when(ago(3 * 3_600_000))).toBe('3 hours ago')
  })

  it('falls back to a date once the phrase stops meaning anything', () => {
    const old = when(ago(5 * 24 * 3_600_000))
    expect(old).not.toContain('ago')
    expect(old.length).toBeGreaterThan(0)
  })
})

group('how long it took', () => {
  it('stays in milliseconds below a second and in seconds above one', () => {
    expect(took(40)).toBe('40ms')
    expect(took(999)).toBe('999ms')
    expect(took(1_000)).toBe('1.0s')
    expect(took(2_400)).toBe('2.4s')
  })
})

group('what a refused call was trying to do', () => {
  it('reads as a phrase after "Refused to", counted from what was asked for', () => {
    // `accepted` is zero on a refusal, so a row counted from it would say "0 objects"
    // and lose the only interesting number on the line.
    expect(asked(event({ tool: 'delete_objects', requested: 2, accepted: 0 }))).toBe(
      'remove 2 objects',
    )
    expect(asked(event({ tool: 'create_nodes', requested: 1, accepted: 0 }))).toBe('add 1 object')
    expect(asked(event({ tool: 'tidy_layout', requested: 9, accepted: 0 }))).toBe('tidy the layout')
  })

  it('falls back to the tool name without underscores', () => {
    expect(asked(event({ tool: 'rearrange_everything', requested: 0, accepted: 0 }))).toBe(
      'rearrange everything',
    )
  })
})
