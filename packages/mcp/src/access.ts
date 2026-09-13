/**
 * What the access token behind this server may do, in the terms a model works in.
 *
 * Read once at startup from `GET /tokens/current` and again whenever the model asks, so
 * the model is told its boundaries in the server's instructions before its first call,
 * sees them per glade in `list_glades`, and never finds a tool it can use nowhere.
 *
 * This is guidance, not the boundary. The API refuses glades a token does not name, and
 * the websocket drops any write the grant does not allow, whatever this process says.
 */

import type { TokenInfo } from './api'

/** The most glades named in the instructions; the rest are one `get_my_access` call away. */
const LISTED_IN_INSTRUCTIONS = 40

function phrase(grant: { edit: boolean; delete: boolean }): string {
  if (grant.edit && grant.delete) return 'read, edit and delete'
  if (grant.edit) return 'read and edit (no delete)'
  if (grant.delete) return 'read and delete (no edit)'
  return 'read only'
}

export function describeBoundaries(info: TokenInfo): string {
  if (info.kind === 'classic') {
    return [
      `This server acts through a classic access token named "${info.name}".`,
      'It can do anything the account can do, on every glade the account can open, including creating glades.',
      "What the account's role allows and whether the owner has locked a glade still apply per glade: list_glades shows can_edit and can_delete for each.",
    ].join(' ')
  }

  const grants = info.grants ?? []
  const lines = grants
    .slice(0, LISTED_IN_INSTRUCTIONS)
    .map((grant) => `- "${grant.title}" (${grant.board_id}): ${phrase(grant)}`)
  if (grants.length > LISTED_IN_INSTRUCTIONS) {
    lines.push(
      `- and ${grants.length - LISTED_IN_INSTRUCTIONS} more; call get_my_access for all of them`,
    )
  }
  return [
    `This server acts through a fine-grained access token named "${info.name}". It can open only these glades:`,
    ...(lines.length === 0
      ? ['- none (every glade it named has been deleted or is no longer open to the account)']
      : lines),
    'Every other glade is invisible to it, and it cannot create or import glades.',
    'Do not attempt an edit or a deletion on a glade where it is not allowed: the server refuses it.',
    "The account's role and the owner's lock can narrow this further. Call get_my_access for the current, exact permissions.",
  ].join('\n')
}

export type ToolNeeds = 'read' | 'edit' | 'delete' | 'create'

/** Whether a tool that needs this could succeed anywhere with this token. */
export function usable(info: TokenInfo, needs: ToolNeeds): boolean {
  if (needs === 'read') return true
  if (info.kind === 'classic') return true
  if (needs === 'create') return info.can_create_glades
  const grants = info.grants ?? []
  return grants.some((grant) => (needs === 'edit' ? grant.edit : grant.delete))
}
