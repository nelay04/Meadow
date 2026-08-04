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

export type TextEditorHandle = {
  focus(): void
  destroy(): void
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
  ]
}

export function createTextEditor(options: TextEditorOptions): TextEditorHandle {
  const editor = new Editor({
    element: options.element,
    extensions: extensions(options.fragment),
    editable: options.editable,
    // The document already holds the content. Passing `content` here would insert it
    // a second time on every mount.
    injectCSS: false,
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Escape') return false
        event.preventDefault()
        options.onExit()
        return true
      },
    },
    onBlur: () => options.onExit(),
  })

  // Style the ProseMirror node with the same function the idle element uses, so the
  // text does not shift by a pixel at the moment the user double-clicks.
  applyContentStyle(editor.view.dom as HTMLElement, options.props)

  editor.commands.focus('end')

  return {
    focus: () => editor.commands.focus('end'),
    destroy: () => editor.destroy(),
  }
}

export type { TextProps }
export { resolveTextProps }
