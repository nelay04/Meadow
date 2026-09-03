/**
 * The address an invitation named, carried from the join screen to the register form.
 *
 * One value, one hop, and it exists because of a specific way this goes wrong.
 * A board invitation is a promise made to an *address*: it applies itself when an
 * account opens at that address and at no other. Somebody who follows the link, reads
 * "you were invited", and then registers with the address they happen to prefer ends
 * up with a working account and no board, and nothing on either screen would have told
 * them why. Prefilling the field is the fix, and it is a nudge rather than a rule -
 * they can still type over it, which is right, because it may genuinely be the wrong
 * address and only they know.
 *
 * `sessionStorage` rather than a prop, because the two screens are not nested: the join
 * page hands off by changing the route, and threading a value through the router for
 * one hop would put a parameter on every view that does not want one. Taken rather than
 * read, so it applies to the next registration and not to every one afterwards.
 */

const KEY = 'meadow:invited-email'

export function rememberInvitedEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email)
  } catch {
    // Private browsing or a full quota. The form opens empty, which is the behaviour
    // this whole module is an improvement on rather than a requirement of.
  }
}

/** Read it once and forget it. */
export function takeInvitedEmail(): string | null {
  try {
    const email = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return email
  } catch {
    return null
  }
}
