/**
 * Phonetic input, over whichever text editor is open or a plain text field, in any
 * script the service knows.
 *
 * You type `amar`, a list of Bengali words appears under the caret, and Space, Enter, a
 * digit or a click puts one of them on the page. `namaste` does the same in Hindi and
 * `privet` in Russian; the language is a per-person setting, in `text/imeStore.ts`. The
 * behaviour is Google Input Tools', because that is the one a typist on the web already
 * has in their hands, and the candidates come from the same service so the ordering
 * matches too - see `text/inputTools.ts`, which also covers what is sent and what
 * happens offline.
 *
 * The roman word stays in the document while it is being typed, rather than being held
 * in some parallel buffer. That is the decision the rest of this file follows from: the
 * caret, selection, wrapping, undo and the CRDT all keep working because nothing is
 * being intercepted - the text is simply replaced when a candidate is chosen. A buffer
 * outside the document would have to reimplement every one of those, and would still
 * lose the letters typed so far if the tab closed mid-word.
 *
 * Lives in `src/overlay`, not `src/canvas`: it is part of the editor, and the engine
 * stays free of both ProseMirror and this.
 */

import { Extension, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { inputLanguageId, subscribeInputLanguage } from '../text/imeStore'
import { inputLanguage } from '../text/inputLanguages'
import { cachedCandidates, fetchCandidates, isOnline } from '../text/inputTools'

/** What the popup can be asked about: a roman word, at a place in the text. */
type Composing = { roman: string; from: number; to: number; language: string }

/**
 * What the input method needs from the thing being typed into.
 *
 * Two of these exist: the rich-text editor on a row or a shape, and a plain `<input>`
 * such as a lea page's subject. Positions are the target's own - ProseMirror positions
 * for the one, string offsets for the other - and the core never does arithmetic on
 * them beyond subtracting a word's length from the caret.
 */
export type ImeTarget = {
  /** Whether typing is allowed at all. A viewer gets no suggestions. */
  editable(): boolean
  /** Whether the operating system's own input method is mid-composition. */
  composing(): boolean
  /**
   * The text between the start of the caret's line and the caret, and where the caret
   * is. Null when there is a selection rather than a caret.
   */
  beforeCaret(): { text: string; caret: number } | null
  /** Viewport coordinates of a text position, to hang the list under. */
  coordsAt(position: number): { left: number; top: number; bottom: number }
  /** Replace a range with text, as one undo step, and leave the caret after it. */
  replace(from: number, to: number, text: string): void
}

/** Bengali numerals, as the input tools page numbers its list. */
const NUMERALS = '০১২৩৪৫৬৭৮৯'

/*
 * The word under the caret, if it is one this can transliterate.
 *
 * Latin letters only, and it has to start with one: `2nd` is not a word being typed
 * phonetically, and neither is the tail of `আমার`. Apostrophes are allowed inside so
 * `don't` is one word rather than two attempts.
 */
const WORD = /[A-Za-z][A-Za-z']*$/

/** Typing one of these ends the word, the way Space does, and is then inserted. */
const TERMINATORS = new Set([',', '.', '?', '!', ';', ':', '"', ')', ']', '}', '-', '/'])

/**
 * The roman word being composed, underlined while it is still roman.
 *
 * A decoration rather than a mark: it is a hint about what the editor is about to do,
 * not something the person wrote, so it must never reach the document or the CRDT. It
 * is recomputed from the selection on every render, which is cheap and cannot go stale
 * the way a stored range would when a peer's edit shifts positions underneath it.
 */
export const PhoneticComposing = Extension.create({
  name: 'phoneticComposing',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            if (inputLanguageId() === null) return null
            const { selection } = state
            if (!selection.empty) return null

            const head = selection.$head
            const before = state.doc.textBetween(head.start(), head.pos, '\n', '\n')
            const match = WORD.exec(before)
            if (match === null) return null

            const from = head.pos - match[0].length
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, head.pos, { class: 'ime-composing' }),
            ])
          },
        },
      }),
    ]
  },
})

export type PhoneticImeHandle = {
  /** Called from the editor's own key handler, before anything else looks at the key. */
  handleKeyDown(event: KeyboardEvent): boolean
  /** Recompute from the current document and selection. */
  update(): void
  /** Whether the candidate list is on screen. The editor asks before exiting on blur. */
  isOpen(): boolean
  /** Take the list away, leaving the text as it is. */
  close(): void
  destroy(): void
}

/** The input method itself, over any target. Call `update` whenever its text or caret moves. */
export function createPhoneticIme(target: ImeTarget): PhoneticImeHandle {
  let composing: Composing | null = null
  let candidates: string[] = []
  let index = 0
  /** A word Escape has closed the list on. It stays closed until the word changes. */
  let dismissed: string | null = null
  let request: AbortController | null = null
  let popup: HTMLElement | null = null

  const close = (): void => {
    composing = null
    candidates = []
    index = 0
    request?.abort()
    request = null
    popup?.remove()
    popup = null
  }

  /*
   * The popup, positioned against the caret rather than against the overlay.
   *
   * `position: fixed` on the document body, from viewport coordinates the editor gives
   * us. The text layer is inside the camera transform, so anything parented to it is
   * scaled with the zoom - a list of words at 320% is not a menu any more. This way the
   * page can be at any zoom and the candidates stay one size, which is also how every
   * other input method on the machine behaves.
   */
  const render = (): void => {
    if (composing === null || candidates.length === 0) {
      popup?.remove()
      popup = null
      return
    }

    if (popup === null) {
      popup = document.createElement('div')
      popup.className = 'ime-popup'
      popup.setAttribute('role', 'listbox')
      // The editor must keep focus. A mousedown that moves it would blur the editor,
      // which closes it, which unmounts the thing being clicked.
      popup.addEventListener('mousedown', (event) => event.preventDefault())
      document.body.appendChild(popup)
    }

    const language = inputLanguage(composing.language)
    popup.setAttribute('aria-label', `${language?.label ?? 'Phonetic'} suggestions`)
    popup.replaceChildren()

    const head = document.createElement('div')
    head.className = 'ime-popup-head'

    const typed = document.createElement('span')
    typed.className = 'ime-popup-typed'
    typed.textContent = composing.roman
    head.appendChild(typed)

    if (language !== null) {
      // Which keyboard this is. Four scripts in this list share a language name in
      // English and none of them share one in their own, so the native name is the one
      // that answers "am I typing Hindi or Marathi" at a glance.
      const name = document.createElement('span')
      name.className = 'ime-popup-language'
      name.textContent = language.native
      head.appendChild(name)
    }
    if (!isOnline()) {
      const note = document.createElement('span')
      note.className = 'ime-popup-offline'
      // Said, not hidden: the list is still correct Bengali, but it is the rule engine's
      // order rather than the ranked one, and that is worth knowing before picking.
      note.textContent = 'offline'
      head.appendChild(note)
    }
    popup.appendChild(head)

    candidates.forEach((word, position) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = position === index ? 'ime-option selected' : 'ime-option'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', position === index ? 'true' : 'false')

      const numeral = document.createElement('span')
      numeral.className = 'ime-option-index'
      numeral.textContent = `${NUMERALS[position + 1] ?? String(position + 1)}.`
      const text = document.createElement('span')
      text.className = 'ime-option-text'
      text.textContent = word

      row.append(numeral, text)
      row.addEventListener('click', () => commit(position))
      popup?.appendChild(row)
    })

    const coords = target.coordsAt(composing.from)
    // Measured after mounting, because a list of six Bengali words is not a fixed size.
    const box = popup.getBoundingClientRect()
    const left = Math.min(coords.left, window.innerWidth - box.width - 8)
    // Under the word by default, above it when there is no room below - the same flip
    // every menu in the app does, and the caret is often near the bottom of the screen.
    const below = coords.bottom + 6
    const top = below + box.height > window.innerHeight - 8 ? coords.top - box.height - 6 : below
    popup.style.left = `${Math.max(8, left)}px`
    popup.style.top = `${Math.max(8, top)}px`
  }

  /** Put a candidate on the page, in place of the roman word. */
  const commit = (position: number, suffix = ''): void => {
    const active = composing
    const word = candidates[position]
    if (active === null || word === undefined) return

    close()
    // One edit, so one Ctrl+Z takes the whole choice back rather than unpicking the
    // Bengali one character at a time.
    target.replace(active.from, active.to, word + suffix)
  }

  const ask = (language: string, roman: string): void => {
    request?.abort()
    const controller = new AbortController()
    request = controller

    void fetchCandidates(language, roman, controller.signal)
      .then((answer) => {
        // The word has moved on while this was in flight.
        if (controller.signal.aborted) return
        if (composing?.roman !== roman || composing.language !== language) return
        candidates = answer.candidates
        index = 0
        render()
      })
      .catch(() => {
        // An abort, or a failure `fetchCandidates` already answered locally for.
      })
  }

  const update = (): void => {
    const language = inputLanguageId()
    if (language === null || !target.editable()) return close()
    // An OS-level input method is mid-composition. Two of them over one caret is one
    // too many, and the browser's own is the one that was asked for.
    if (target.composing()) return close()

    const before = target.beforeCaret()
    if (before === null) return close()
    const match = WORD.exec(before.text)
    if (match === null) return close()

    const roman = match[0]
    if (roman === dismissed) return close()
    dismissed = null

    const from = before.caret - roman.length
    composing = { roman, from, to: before.caret, language }

    // A word already asked about paints immediately; the rest waits on the service but
    // shows the previous list until it answers, so the popup never blinks out mid-word.
    const known = cachedCandidates(language, roman)
    if (known !== null) {
      candidates = known
      index = 0
    }
    render()
    if (known === null) ask(language, roman)
  }

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (composing === null || candidates.length === 0) return false
    if (event.ctrlKey || event.metaKey || event.altKey) return false

    switch (event.key) {
      case 'ArrowDown':
        index = (index + 1) % candidates.length
        render()
        return true
      case 'ArrowUp':
        index = (index - 1 + candidates.length) % candidates.length
        render()
        return true
      case 'Enter':
      case 'Tab':
        commit(index)
        return true
      case ' ':
        // The space is part of the same edit, so the word and the gap after it are one
        // undo step and the caret is already past the word for the next one.
        commit(index, ' ')
        return true
      case 'Escape':
        // Leaves the roman where it is. Escape in an editor closes the innermost thing
        // that is open, and that is this list, not the editor.
        dismissed = composing.roman
        close()
        return true
      default:
        break
    }

    if (event.key.length === 1 && event.key >= '1' && event.key <= '9') {
      const position = Number(event.key) - 1
      if (position < candidates.length) {
        commit(position)
        return true
      }
      return false
    }

    if (event.key.length === 1 && TERMINATORS.has(event.key)) {
      commit(index, event.key)
      return true
    }

    return false
  }

  // Turning the option off with a word half typed has to take the list away with it.
  const unsubscribe = subscribeInputLanguage(() => {
    dismissed = null
    update()
  })

  return {
    handleKeyDown,
    update,
    isOpen: () => popup !== null,
    close,
    destroy: () => {
      unsubscribe()
      close()
    },
  }
}

/** The input method over a rich-text editor. */
export function attachPhoneticIme(editor: Editor): PhoneticImeHandle {
  const ime = createPhoneticIme({
    editable: () => editor.isEditable,
    composing: () => editor.view.composing,
    beforeCaret: () => {
      const { selection } = editor.state
      if (!selection.empty) return null
      const head = selection.$head
      return {
        text: editor.state.doc.textBetween(head.start(), head.pos, '\n', '\n'),
        caret: head.pos,
      }
    },
    coordsAt: (position) => editor.view.coordsAtPos(position),
    replace: (from, to, text) => {
      editor.view.dispatch(editor.view.state.tr.insertText(text, from, to))
      editor.view.focus()
    },
  })

  const onTransaction = (): void => ime.update()
  editor.on('transaction', onTransaction)
  editor.on('selectionUpdate', onTransaction)

  return {
    ...ime,
    destroy: () => {
      editor.off('transaction', onTransaction)
      editor.off('selectionUpdate', onTransaction)
      ime.destroy()
    },
  }
}

/**
 * Where a string offset in a single-line input sits on screen.
 *
 * An input exposes no geometry for its text, so the run before the offset is measured
 * with the input's own font and placed from its left padding, less however far it has
 * scrolled. Exact enough to hang a list under a word.
 */
let measureContext: CanvasRenderingContext2D | null = null

function inputCoords(input: HTMLInputElement, offset: number): {
  left: number
  top: number
  bottom: number
} {
  const box = input.getBoundingClientRect()
  const style = getComputedStyle(input)
  measureContext ??= document.createElement('canvas').getContext('2d')
  let width = 0
  if (measureContext !== null) {
    measureContext.font = style.font
    width = measureContext.measureText(input.value.slice(0, offset)).width
  }
  const left =
    box.left + input.clientLeft + parseFloat(style.paddingLeft) + width - input.scrollLeft
  // The line box, centred in the content box the way an input lays out its one line.
  const contentTop = box.top + input.clientTop + parseFloat(style.paddingTop)
  const contentHeight = input.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
  const top = contentTop + (contentHeight - lineHeight) / 2
  return { left, top, bottom: top + lineHeight }
}

/**
 * The input method over a single-line `<input>`, such as a lea page's subject.
 *
 * The edit goes through `insertText`, which is what typing does: the browser's own undo
 * takes the whole word back, and a React-controlled input hears an ordinary input event.
 * Returns the teardown.
 */
export function attachPhoneticInput(input: HTMLInputElement): () => void {
  let osComposing = false

  const ime = createPhoneticIme({
    // Focus too: the language switch asks every attached field to look again, and a
    // field nobody is typing in must not open a list for the word it happens to end on.
    editable: () => !input.disabled && !input.readOnly && document.activeElement === input,
    composing: () => osComposing,
    beforeCaret: () => {
      const { selectionStart: start, selectionEnd: end } = input
      if (start === null || start !== end) return null
      return { text: input.value.slice(0, start), caret: start }
    },
    coordsAt: (position) => inputCoords(input, position),
    replace: (from, to, text) => {
      input.focus()
      input.setSelectionRange(from, to)
      if (!document.execCommand('insertText', false, text)) {
        input.setRangeText(text, from, to, 'end')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    },
  })

  // A caret moved by a click or an arrow key moves the word under it too. Deferred,
  // because on keydown the caret has not moved yet.
  const refresh = (): void => {
    requestAnimationFrame(() => {
      if (document.activeElement === input) ime.update()
    })
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (ime.handleKeyDown(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    refresh()
  }
  const onStart = (): void => {
    osComposing = true
    ime.update()
  }
  const onEnd = (): void => {
    osComposing = false
    ime.update()
  }
  // Leaving the field takes the list with it, unless the click that left was on the
  // list itself, which never takes focus.
  const onBlur = (): void => {
    osComposing = false
    ime.close()
  }

  input.addEventListener('keydown', onKeyDown)
  input.addEventListener('input', ime.update)
  input.addEventListener('click', refresh)
  input.addEventListener('focus', refresh)
  input.addEventListener('blur', onBlur)
  input.addEventListener('compositionstart', onStart)
  input.addEventListener('compositionend', onEnd)

  return () => {
    input.removeEventListener('keydown', onKeyDown)
    input.removeEventListener('input', ime.update)
    input.removeEventListener('click', refresh)
    input.removeEventListener('focus', refresh)
    input.removeEventListener('blur', onBlur)
    input.removeEventListener('compositionstart', onStart)
    input.removeEventListener('compositionend', onEnd)
    ime.destroy()
  }
}
