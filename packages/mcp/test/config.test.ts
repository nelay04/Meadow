import { describe, expect, it } from 'vitest'

import { parseConfig } from '../src/config'

const base = ['--api', 'http://127.0.0.1:8012', '--token', 'mdw_x']

describe('snapshots switch', () => {
  it('is on by default', () => {
    expect(parseConfig(base, {}).snapshots).toBe(true)
  })

  it('turns off with the flag or the environment', () => {
    expect(parseConfig([...base, '--no-snapshots'], {}).snapshots).toBe(false)
    expect(parseConfig(base, { MEADOW_MCP_SNAPSHOTS: 'off' }).snapshots).toBe(false)
    expect(parseConfig(base, { MEADOW_MCP_SNAPSHOTS: 'FALSE' }).snapshots).toBe(false)
    expect(parseConfig(base, { MEADOW_MCP_SNAPSHOTS: 'on' }).snapshots).toBe(true)
  })
})
