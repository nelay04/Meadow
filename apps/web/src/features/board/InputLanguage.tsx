/**
 * Which script the keyboard writes in.
 *
 * A menu rather than a switch, because there are twenty-nine of them. The button itself
 * is still a switch: clicking it turns the input method off and on, and the caret beside
 * it opens the list - so the common case, going back and forth between your own script
 * and English, stays one click and never a menu.
 *
 * The same value as `Ctrl+G`, and the same value the editor reads. It lives in
 * `text/imeStore.ts` rather than in this component or in the document: it is the
 * person's keyboard, not the board's, and it follows them from lea to lea.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  inputLanguageId,
  setInputLanguage,
  subscribeInputLanguage,
  toggleInputLanguage,
} from '../../text/imeStore'
import { INPUT_LANGUAGES, inputLanguage } from '../../text/inputLanguages'
import { IconCheck } from '../../ui/icons'

export function InputLanguage() {
  const active = useSyncExternalStore(subscribeInputLanguage, inputLanguageId, () => null)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const language = inputLanguage(active)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (id: string | null): void => {
    setOpen(false)
    setInputLanguage(id)
  }

  return (
    <div className="dropdown input-language" ref={root}>
      {/*
        Neither button may take focus. Both of them are pressed while a caret is sitting
        in a line, and taking focus blurs the editor, which ends the edit - so switching
        scripts mid-sentence would close the line you were switching it for.
      */}
      <button
        type="button"
        className={active === null ? 'icon ghost bengali-toggle' : 'icon ghost active bengali-toggle'}
        aria-pressed={active !== null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => toggleInputLanguage()}
        title={
          language === null
            ? 'Type phonetically (Ctrl+G)'
            : `${language.label} is on (Ctrl+G). Type ${language.sample[0]}, choose ${language.sample[1]}.`
        }
        aria-label={
          language === null ? 'Turn on phonetic typing' : `Turn off phonetic ${language.label}`
        }
      >
        <span aria-hidden="true">{language?.glyph ?? 'A'}</span>
      </button>

      <button
        type="button"
        className={open ? 'icon ghost caret active' : 'icon ghost caret'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((shown) => !shown)}
        title="Choose a script"
        aria-label="Choose a script"
      >
        <span aria-hidden="true" className="caret-glyph" />
      </button>

      {open && (
        <div className="menu menu-language" role="listbox" aria-label="Phonetic typing">
          <button
            type="button"
            role="option"
            aria-selected={active === null}
            className={active === null ? 'menu-item selected' : 'menu-item'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(null)}
          >
            <span className="menu-label">Off, type in English</span>
            {active === null && <IconCheck size={15} />}
          </button>

          <div className="menu-rule" role="presentation" />

          {INPUT_LANGUAGES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === active}
              className={option.id === active ? 'menu-item selected' : 'menu-item'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(option.id)}
            >
              <span className="menu-label">{option.label}</span>
              {/* Its own name, and what a word of it looks like. Between them they say
                  which of Hindi, Marathi, Nepali and Sanskrit you are about to get -
                  four languages, one script, and no way to tell from the English name
                  alone what will appear on the page. */}
              <span className="menu-native">{option.native}</span>
              {option.id === active && <IconCheck size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
