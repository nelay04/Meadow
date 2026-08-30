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
 * Undo is deliberately split. Collaboration brings its own `Y.UndoManager` over the
 * fragment, so Ctrl+Z inside the editor undoes typing. The session's UndoManager in
 * doc/mutations tracks only the local origin, which the editor's writes do not use, so
 * object-level undo never reaches inside a paragraph. Those are the two behaviours a
 * user expects, and getting them from one stack would mean an undo of a move reverting
 * someone's sentence.
 */

import { type TextProps, resolveTextProps } from '@meadow/schema'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import type * as Y from 'yjs'

import { applyContentStyle } from '../canvas/text/textStyle'
import { TEXT_MARKS, type TextMark } from '../doc/richText'
import { PhoneticComposing, attachPhoneticIme } from './phoneticIme'

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

export function createTextEditor(options: TextEditorOptions): TextEditorHandle {
  // Assigned below, after the editor exists, and read from inside its own key handler.
  // The handler cannot run before construction returns, so the hole is never observed.
  let ime: ReturnType<typeof attachPhoneticIme> | null = null

  const editor = new Editor({
    element: options.element,
    extensions: extensions(options.fragment),
    editable: options.editable,
    // The document already holds the content. Passing `content` here would insert it
    // a second time on every mount.
    injectCSS: false,
    editorProps: {
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

        if (event.key === 'Escape') {
          event.preventDefault()
          options.onExit()
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

  editor.commands.focus('end', FOCUS)

  return {
    focus: () => editor.commands.focus('end', FOCUS),
    destroy: () => {
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
