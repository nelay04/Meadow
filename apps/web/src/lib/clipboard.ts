/**
 * Copying to the clipboard, from the two screens that hand somebody a string.
 *
 * Here rather than beside either of them because there are now two: the share dialog's
 * link, and the temporary password the recovery flow puts on screen. The awkward part
 * below is the same awkward part for both, and a second copy of it would be a second
 * thing to remember when a browser changes its mind about permissions.
 */

/**
 * Copy, by whichever route the browser allows.
 *
 * `navigator.clipboard` is unavailable on plain http beyond localhost, which is most
 * development and every deployment behind an un-TLS'd proxy - exactly where somebody
 * is most likely to be testing this. The fallback is deprecated and still works
 * everywhere, and a copy button that silently does nothing is worse than either.
 */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through.
  }
  try {
    const field = document.createElement('textarea')
    field.value = text
    // Off-screen rather than hidden: `display: none` cannot be selected from.
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    const done = document.execCommand('copy')
    field.remove()
    return done
  } catch {
    return false
  }
}

