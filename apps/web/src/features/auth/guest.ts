/**
 * Who somebody is on a public board when they are nobody in particular.
 *
 * A visitor on a share link has no account, and presence still needs an identity: a
 * key to hang a cursor on, a name for the face row, and a colour. All three are made
 * here, on the client, and none of them is a claim about anything. The server has its
 * own guest id inside the websocket token - see `app/realtime/wstoken.py` - and that
 * one is for its logs; this one is for the other people in the room, who need to be
 * able to say "the other cursor" and mean a particular other cursor.
 *
 * Kept in `sessionStorage` rather than made fresh on every render or every reload. Per
 * tab is exactly the right lifetime: reloading a board should not make you a different
 * person to everyone watching, and opening a second tab genuinely is a second cursor.
 * `localStorage` would be wrong in the other direction - a name chosen for a link you
 * followed once should not still be following you next month.
 *
 * The names are deliberately not anonymising-by-numbering. "Guest 4f2a" tells nobody
 * anything and reads like a database row; three guests called Hare, Wren and Otter can
 * be talked about out loud, which is the entire job of a name in a shared room.
 */

const KEY = 'meadow:guest'

/**
 * Small, concrete, and all one syllable or two.
 *
 * Meadow creatures, because the boards are glades and leas and the cursors are
 * wanderers. Sixteen of them: enough that a collision in one room is unlikely, few
 * enough that they stay recognisable rather than becoming a taxonomy.
 */
const CREATURES = [
  'Hare', 'Wren', 'Otter', 'Fox', 'Heron', 'Badger', 'Finch', 'Vole',
  'Stoat', 'Swift', 'Newt', 'Moth', 'Lark', 'Marten', 'Curlew', 'Shrew',
]

export type GuestIdentity = {
  id: string
  name: string
}

function make(): GuestIdentity {
  const id = crypto.randomUUID()
  // Drawn from the id rather than rolled separately, so the name and the colour - which
  // `colorFor` also derives from the id - are stable together for as long as the id is.
  const index = Number.parseInt(id.slice(0, 8), 16) % CREATURES.length
  return { id, name: CREATURES[index] }
}

let cached: GuestIdentity | null = null

/** This tab's guest identity, made once and remembered for the tab. */
export function guestIdentity(): GuestIdentity {
  if (cached !== null) return cached

  try {
    const stored = sessionStorage.getItem(KEY)
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<GuestIdentity>
      if (typeof parsed.id === 'string' && typeof parsed.name === 'string') {
        cached = { id: parsed.id, name: parsed.name }
        return cached
      }
    }
  } catch {
    // Private browsing, a storage quota, or a value somebody hand-edited. None of them
    // is a reason to fail to open a board: a fresh identity works perfectly, it just
    // will not survive the reload.
  }

  cached = make()
  try {
    sessionStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    // Same again. The in-memory copy is enough for this page.
  }
  return cached
}
