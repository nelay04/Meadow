/**
 * The active text editor. ARCHITECTURE 5, step 2 of the text object lifecycle.
 *
 * Idle text objects are static HTML in the overlay. Exactly one object at a time gets
 * a real TipTap instance, mounted on double-click and destroyed on blur or Escape.
 * That is the whole reason ProseMirror lives here and not in `src/canvas`: the engine
 * stays free of it, receives this through a factory on `EngineHost`, and remains
 * extractable.
 *
 * The editor binds straight to the object's `Y.XmlFragment`. Nothing is copied in or
 * out. Two people typing in the same text object merge character by character, and the
 * document is already correct the instant a key is pressed, so there is no save step
 * that can be missed by a crash or a navigation.
 *
 * Undo is the document's, not the editor's, and that is a reversal of how this file
 * started. Collaboration builds its own `Y.UndoManager` over the fragment, and the two
 * behaviours that stack cannot have are the two a diary needs most: it is scoped to one
 * object, so writing on the next rule is a separate history, and it is built by the
 * plugin and destroyed with the editor, so the history of a row is gone the moment the
 * caret leaves it. On a lea, where every rule is its own object and the caret moves
 * between them constantly, that made Ctrl+Z reach about as far as the last thing typed
 * and no further.
 *
 * So the keys are intercepted here - direct editor props are consulted before any
 * plugin's keymap - and sent to the session's UndoManager, which is scoped to the
 * document roots and lives as long as the board is open. `EDITOR_ORIGIN` below is what
 * lets it see typing at all.
 *
 * The old worry, that one stack means "an undo of a move reverts someone's sentence",
 * is answered by the origin filter rather than by a second stack: the session manager
 * tracks this client's own edits only, so Ctrl+Z walks back through your own writing
 * and your own moves, in the order you made them, and never through anybody else's.
 */

import { type TextProps, resolveTextProps } from '@meadow/schema'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { PluginKey } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import type * as Y from 'yjs'

import { applyContentStyle } from '../canvas/text/textStyle'
import { TEXT_MARKS, type TextMark } from '../doc/richText'
import { inputLanguageId, subscribeInputLanguage } from '../text/imeStore'
import { spellcheckEnabled, subscribeSpellcheck } from '../text/spellcheckStore'
import { PhoneticComposing, attachPhoneticIme } from './phoneticIme'

/**
 * What the editor's writes into the document look like, for `Y.UndoManager`.
 *
 * y-prosemirror wraps every local keystroke in a Yjs transaction of its own, tagged
 * with `ySyncPluginKey` as the origin - so that plugin key is what a piece of typing
 * is signed with. `Y.UndoManager` matches a tracked origin by identity *or* by
 * constructor, and the key itself is not reachable from here - `@tiptap/y-tiptap` is a
 * transitive dependency, not one this app declares - so the class is what is handed
 * over. Nothing else in this app writes under a `PluginKey` origin, which is what makes
 * the wider match exact in practice.
 *
 * It is exported from this file on purpose. The document layer must not have to know
 * what a ProseMirror plugin is; the editor knows what its own writes look like, and
 * says so once, here. See `createDocSession`.
 */
export const EDITOR_ORIGIN: unknown = PluginKey

export type TextEditorHandle = {
  focus(): void
  destroy(): void
  /** Toggle a mark over the current selection, or at the caret for the next typing. */
  toggleMark(mark: TextMark): void
  /** Which marks are on at the caret. Drives the pressed state of the bar. */
  activeMarks(): TextMark[]
}

export type TextEditorOptions = {
  /** The overlay content element the editor mounts into. */
  element: HTMLElement
  fragment: Y.XmlFragment
  props: TextProps
  /** True when the role may write; a viewer gets a caret and selection but no edits. */
  editable: boolean
  /**
   * Whether this surface is one the browser should mark misspellings on.
   *
   * The surface's half of the answer, not the reader's: a writing page says yes and a
   * canvas says no, and the reader's own switch in `text/spellcheckStore.ts` is ANDed
   * with it below. Both have to agree, so turning the preference on does not put
   * underlines under the label of a shape.
   */
  spellcheck: boolean
  /** Escape, or focus leaving the editor. */
  onExit(): void
  /**
   * The marks under the caret, whenever they change.
   *
   * Pushed rather than polled. Marks change on every keystroke and every selection
   * move, and a timer fast enough to keep the bar honest is a timer running for the
   * whole time somebody is typing.
   */
  onMarks?(marks: TextMark[]): void
  /**
   * The caret tried to walk off the top or the bottom of this object.
   *
   * Only ever called from the first or the last line: inside the text, Up and Down do
   * what they do everywhere else. Return true to say the move was taken somewhere
   * else, which suppresses the key; false leaves it to the editor.
   *
   * This is what makes a ruled page behave like ruled paper rather than like a stack
   * of boxes. Every rule is its own object, so without it Down at the end of a line is
   * a key that does nothing at all.
   */
  onLeave?(direction: 'up' | 'down'): boolean
  /**
   * A newline is about to make this object one line taller.
   *
   * Asked before the key is allowed through, because on a ruled page height is not
   * free: a row is as many rules tall as it is lines, and the page has a last rule.
   * `lines` is how many it would gain: one for a newline, and as many as it carries for
   * a paste. Return true to let it happen - the usual answer, and always the answer on a
   * surface with no page - or false to refuse it, which is what stops the writing
   * running off the bottom of the paper onto nothing.
   *
   * The caret only, never a selection: replacing selected text can just as easily make
   * the object shorter, and asking for paper on the way to a line that is about to be
   * deleted would lengthen a page nobody wrote on.
   */
  onGrow?(lines: number): boolean
  /**
   * Ctrl+Z and Ctrl+Y, handed to whoever owns the document's history.
   *
   * Undefined leaves the editor's own fragment-scoped stack in place, which is the
   * right answer for a harness with no session behind it and the wrong one for the app.
   */
  onUndo?(): void
  onRedo?(): void
  /**
   * Ctrl+A pressed when this object's own text is already all selected.
   *
   * The escalation everything with nested selections uses: the first press takes the
   * line, the second takes the page. It has to be an escalation rather than a straight
   * override, because a ProseMirror selection cannot reach past the object it is in -
   * so "all of the page" is not a bigger version of this selection, it is a different
   * one, held somewhere else, and the caret leaves when it is taken.
   */
  onSelectAll?(): boolean
  /**
   * Backspace pressed with the caret at the very start of this object.
   *
   * There is nothing in front of the caret to delete, so on an ordinary text box the
   * key does nothing. On ruled paper the thing in front of the caret is the rule, and
   * the line is expected to come up to meet the one above it - so the surface is asked,
   * and answers true when it took the key.
   */
  onJoin?(): boolean
  /**
   * Where to put the caret on mount, counted in characters from the start of the text.
   *
   * Characters rather than a ProseMirror position, because the caller is the surface
   * and the surface must not have to know how ProseMirror numbers a document. Undefined
   * means the end, which is where a caret arriving at a row belongs every other time.
   */
  caretChars?: number
}

/**
 * Extensions are pinned to what `doc/richText.ts` can serialise back to static HTML.
 *
 * The two lists are one decision in two files. A node type the editor can produce but
 * the serialiser cannot render would look fine while being typed and then vanish the
 * moment the editor closed, which is a far worse failure than not offering it.
 */
function extensions(fragment: Y.XmlFragment) {
  return [
    StarterKit.configure({
      // Collaboration supplies a Yjs-aware undo stack. Leaving ProseMirror's own in
      // place gives two histories over one document and they disagree immediately.
      undoRedo: false,
      // Not serialisable by richText.ts, so not offered.
      horizontalRule: false,
      link: false,
      // Appends an empty paragraph after the last block. Convenient in a page editor,
      // but here it is a phantom line of height in every measurement.
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
    }),
    Collaboration.configure({ fragment }),
    // Draws nothing unless phonetic input is on and a roman word is under the caret.
    PhoneticComposing,
  ]
}

/**
 * Which language the browser should mark misspellings in, or null to let it choose.
 *
 * Null is not "no spellcheck" - it is the more useful of the two answers, and it is what
 * "every available language" actually means on the web. A page cannot install
 * dictionaries or enumerate the ones a reader has; all it can do is either name one
 * language or say nothing. Chrome, told nothing, checks against every dictionary the
 * reader has enabled at once, so saying nothing is what gets a bilingual writer
 * underlines in both of their languages.
 *
 * So the only time it is worth naming one is when the writer has already said which
 * script they are in, by turning the phonetic keyboard on. Then it is named, which is
 * what lets Firefox - which checks one language at a time - pick that one rather than
 * whatever was last used.
 *
 * The honest limit, worth being plain about: browsers ship no dictionaries for most of
 * the scripts in `inputLanguages.ts`. A Bengali lea will show no underlines on any
 * browser we know of, and this is the whole of what a web page is permitted to do about
 * that. Nothing here is broken when that happens - there is simply no dictionary to ask.
 */
function spellcheckLanguage(): string | null {
  return inputLanguageId()
}

/** The `spellcheck` and `lang` attributes the ProseMirror node should be carrying now. */
function spellcheckAttributes(on: boolean): Record<string, string> {
  // Written out even when off, rather than left absent. A contenteditable with no
  // `spellcheck` attribute inherits one, and the answer to "should this be checked"
  // must not depend on what happens to be above the overlay in the DOM.
  if (!on) return { spellcheck: 'false' }

  const attributes: Record<string, string> = { spellcheck: 'true' }
  const language = spellcheckLanguage()
  // Absent rather than empty. `lang=""` is "unknown language", which stops the check
  // in some browsers - the opposite of leaving the choice open.
  if (language !== null) attributes.lang = language
  return attributes
}

export function createTextEditor(options: TextEditorOptions): TextEditorHandle {
  /*
   * Both halves of the answer, read fresh every time the attributes are computed.
   *
   * The surface's half is fixed for the life of this editor - a lea does not become a
   * glade while you are typing on it - so it is read from `options`. The reader's half
   * can move underneath us, which is what the subscriptions below are for.
   */
  const spellcheckOn = (): boolean => options.spellcheck && spellcheckEnabled()

  // Assigned below, after the editor exists, and read from inside its own key handler.
  // The handler cannot run before construction returns, so the hole is never observed.
  let ime: ReturnType<typeof attachPhoneticIme> | null = null

  /*
   * Run an undo or a redo, then put the caret back at the end of the writing.
   *
   * The document's UndoManager knows what to change and nothing about where the caret
   * was - that was the one thing the editor's own stack did for free, through the
   * relative selection y-prosemirror stores on each stack item. Without it the restored
   * text arrived around a caret that had not moved, so a redo appeared to type itself
   * out to the right of the cursor and the next keystroke landed in the middle of it.
   *
   * The end of the row rather than a remembered offset: a row is one line of a diary,
   * the writing that just came back is nearly always the end of it, and a position that
   * is always sensible beats one that is exact four times in five. Deferred by a frame
   * because the change reaches ProseMirror through the Yjs observer, so at the moment
   * the key is handled the text is not in the view yet.
   */
  const restoreCaret = (run: () => void): void => {
    run()
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return
      editor.commands.focus('end')
    })
  }

  const editor = new Editor({
    element: options.element,
    extensions: extensions(options.fragment),
    editable: options.editable,
    // The document already holds the content. Passing `content` here would insert it
    // a second time on every mount.
    injectCSS: false,
    editorProps: {
      /*
       * The browser's own spellchecker, and what language to run it in.
       *
       * A function rather than an object because both halves move while the editor is
       * open: ProseMirror re-reads this on every update and rebuilds the node
       * decoration that carries the attributes, so a switch flipped mid-sentence takes
       * effect without remounting the editor. It is also why these cannot simply be set
       * on `view.dom` - the same decoration pass would strip them off again.
       */
      attributes: () => spellcheckAttributes(spellcheckOn()),

      /*
       * A paste is the other way writing gets taller, and the bigger one by far.
       *
       * Enter asks for one rule; a paragraph off a web page can arrive as thirty, and
       * a page that was one line from its last rule would have swallowed all of them
       * onto bare paper. Counted as blocks rather than as characters because a rule is
       * a line and a block is what starts one - wrapping inside a block is measured by
       * the row itself afterwards, which no count taken before the paste can know.
       *
       * The first block continues the line the caret is already on, so it is the ones
       * after it that need rules of their own.
       */
      handlePaste: (_view, _event, slice) => {
        if (options.onGrow === undefined) return false
        const added = Math.max(0, slice.content.childCount - 1)
        if (added === 0) return false
        // Refused: swallow the paste rather than let it run off the page.
        return !options.onGrow(added)
      },

      handleKeyDown: (view, event) => {
        /*
         * The input method looks at every key first, and that ordering is the whole of
         * it: Enter, Space, Escape and the arrows all mean something to a candidate
         * list that is open and something else entirely to the page underneath. It
         * answers false whenever no list is open, which is nearly always.
         */
        if (ime?.handleKeyDown(event) === true) {
          event.preventDefault()
          return true
        }

        /*
         * Undo and redo belong to the document, not to this object. Taken here rather
         * than by unbinding Collaboration's keymap, because a direct editor prop is
         * consulted before any plugin's, so this wins without touching the extension.
         *
         * All three chords, exactly as the canvas binds them: Ctrl+Y and Ctrl+Shift+Z
         * both redo, because somebody who reaches for the wrong one should not conclude
         * the redo stack is empty.
         */
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const key = event.key.toLowerCase()
          if (key === 'z' && options.onUndo !== undefined && options.onRedo !== undefined) {
            event.preventDefault()
            if (event.shiftKey) restoreCaret(options.onRedo)
            else restoreCaret(options.onUndo)
            return true
          }
          if (key === 'y' && !event.shiftKey && options.onRedo !== undefined) {
            event.preventDefault()
            restoreCaret(options.onRedo)
            return true
          }
        }

        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === 'a' &&
          options.onSelectAll !== undefined
        ) {
          // Already holding the whole of this object, so this press means more than
          // this object. `Selection.atStart/atEnd` rather than the doc's own size,
          // because an empty row is legitimately "all selected" at a single position.
          const { from, to } = view.state.selection
          const all = from <= 1 && to >= view.state.doc.content.size - 1
          if (all && options.onSelectAll()) {
            event.preventDefault()
            return true
          }
          return false
        }

        /*
         * Backspace at the very start of a row is a join, not a deletion.
         *
         * Handed over whole rather than conditionally, because the default here is to
         * do nothing at all: there is no character before the caret, so nothing is lost
         * by taking the key even on a surface that answers false.
         *
         * Deferred by a frame on purpose. A join that lands on the row above destroys
         * this editor and mounts one there, and doing that from inside this editor's
         * own key handler is tearing the view down while it is still using it.
         */
        if (
          event.key === 'Backspace' &&
          options.onJoin !== undefined &&
          view.state.selection.empty &&
          view.state.selection.from <= 1
        ) {
          const join = options.onJoin
          event.preventDefault()
          requestAnimationFrame(() => join())
          return true
        }

        if (event.key === 'Escape') {
          event.preventDefault()
          options.onExit()
          return true
        }

        /*
         * Enter is the one key that adds a line without typing anything into it, so it
         * is the one key that can walk writing off the end of the page. Shift+Enter is
         * included because a hard break lands on the next rule exactly as a paragraph
         * does - what counts here is the height, not which node produced it.
         */
        if (event.key === 'Enter' && options.onGrow !== undefined) {
          if (!view.state.selection.empty) return false
          if (options.onGrow(1)) return false
          // Refused: there is no rule under this one and none could be added. Swallow
          // the key rather than letting it push the writing onto bare paper.
          event.preventDefault()
          return true
        }

        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
        if (options.onLeave === undefined) return false

        const down = event.key === 'ArrowDown'
        const selection = view.state.selection
        // A selection being dragged with the keyboard is not a caret walking out.
        if (!selection.empty) return false
        // ProseMirror's own answer to "would this move leave the line", which accounts
        // for wrapping. A row whose writing has wrapped over three rules steps through
        // all three before this is reached.
        if (!view.endOfTextblock(down ? 'down' : 'up')) return false

        // And the outermost block, so a second paragraph inside one row is stepped
        // into rather than jumped over.
        const head = selection.$head
        const atEdge = down
          ? head.after(1) >= view.state.doc.content.size
          : head.before(1) <= 0
        if (!atEdge || !options.onLeave(down ? 'down' : 'up')) return false

        event.preventDefault()
        return true
      },
    },
    onBlur: () => options.onExit(),
  })

  // Style the ProseMirror node with the same function the idle element uses, so the
  // text does not shift by a pixel at the moment the user double-clicks.
  applyContentStyle(editor.view.dom as HTMLElement, options.props)

  /*
   * Recompute the attributes when either half of the answer moves.
   *
   * An empty transaction, which is the cheapest way to ask ProseMirror to run its
   * decoration pass again: it carries no steps, so Yjs sees nothing to send and the
   * undo stack gains nothing, but the view still recomputes the node decoration that
   * holds `spellcheck` and `lang`.
   *
   * Both stores are subscribed even on a surface that never spellchecks. The transaction
   * is a no-op there - `spellcheckOn()` stays false - and one unconditional pair of
   * subscriptions is less to get wrong than a pair that has to be torn down conditionally.
   */
  const refreshSpellcheck = (): void => {
    if (editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr)
  }
  const unsubscribe = [
    subscribeSpellcheck(refreshSpellcheck),
    subscribeInputLanguage(refreshSpellcheck),
  ]

  // Only where typing happens. A viewer has a caret for selecting text and nothing to
  // transliterate into.
  if (options.editable) ime = attachPhoneticIme(editor)

  const activeMarks = (): TextMark[] => TEXT_MARKS.filter((mark) => editor.isActive(mark))

  if (options.onMarks !== undefined) {
    const publish = (): void => options.onMarks?.(activeMarks())
    editor.on('transaction', publish)
    editor.on('selectionUpdate', publish)
    publish()
  }

  /*
   * Focus, but do not let ProseMirror scroll anything to reveal the caret.
   *
   * On this surface the caret is already where the user clicked - the engine put the
   * row there - and the only thing entitled to move the view is the camera. A DOM
   * scroll moves the text layer and not the canvas under it, which is drift rather
   * than navigation. The overlay root is `overflow: clip` for the same reason; this is
   * the other half, and it also covers the ancestors above it.
   */
  const FOCUS = { scrollIntoView: false }

  /**
   * A character offset as a position in this document.
   *
   * Blocks are counted as the newline that `fragmentToPlainText` writes between them,
   * so an offset taken off plain text lands in the same place here. Anything that runs
   * off the end answers with the end, which is the right place for a caret that cannot
   * be put exactly where it was asked for.
   */
  const caretAt = (chars: number): number => {
    let remaining = chars
    let found: number | null = null
    let seenBlock = false
    editor.state.doc.descendants((node, pos) => {
      if (found !== null) return false
      if (!node.isTextblock) return true

      if (seenBlock) remaining -= 1
      seenBlock = true
      const length = node.textContent.length
      // `pos` is before the block, so its text starts one along.
      if (remaining <= length) found = pos + 1 + Math.max(0, remaining)
      else remaining -= length
      // Never into the block: its text was just counted whole.
      return false
    })
    return found ?? editor.state.doc.content.size
  }

  editor.commands.focus(
    options.caretChars === undefined ? 'end' : caretAt(options.caretChars),
    FOCUS,
  )

  return {
    focus: () => editor.commands.focus('end', FOCUS),
    destroy: () => {
      for (const stop of unsubscribe) stop()
      ime?.destroy()
      editor.destroy()
    },
    toggleMark: (mark) => {
      // `focus()` first, and it is not decoration. The bar lives outside the editor,
      // so by the time a click lands the selection is only remembered, not live;
      // running the command without restoring focus applies it to nothing.
      editor.chain().focus(null, FOCUS).toggleMark(mark).run()
    },
    activeMarks,
  }
}

export type { TextMark, TextProps }
export { resolveTextProps }
