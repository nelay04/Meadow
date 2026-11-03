/**
 * Part of a glade as an image file: what is on screen, or the selection.
 *
 * Never the whole board. A glade is unbounded, and "everything" on a board that has
 * grown for a year is a picture of specks; the camera is already how a person says
 * which part they mean.
 *
 * SVG first, because it is the only answer to "sharp however far you zoom into it,
 * however big the diagram is". PNG is offered for the places that only take pixels,
 * rendered from that same SVG at the density picked, and the dialog says plainly when
 * a density was capped so nobody mistakes the ceiling for the whole picture.
 *
 * The file is built when the dialog opens and again when the area or the background
 * changes, so the preview is the file itself rather than an impression of it, and the
 * download is immediate.
 */

import { useEffect, useRef, useState } from 'react'

import { gladeFilename } from '@meadow/document-core'

import type { CanvasEngine } from '../../canvas/engine'
import {
  type SceneImage,
  pngEstimator,
  pngSize,
  rasterizeSvg,
} from '../../canvas/export/exportScene'
import { useToast } from '../../ui/Toaster'

type Props = {
  engine: CanvasEngine
  title: string
  /** How many objects are selected, for offering the selection at all. */
  selected: number
  onClose: () => void
}

type Area = 'view' | 'selection'
type Format = 'svg' | 'png'

/**
 * Pixels per world unit. A world unit is a screen pixel at 100% zoom, so 16x is a
 * printed poster of what is on screen. Past one canvas the PNG is drawn in tiles; see
 * `rasterizeSvg`.
 */
const DENSITIES = [2, 4, 8, 16, 32, 64] as const

/** Past this many pixels a PNG takes noticeable time to make, and the dialog says so. */
const SLOW_PIXELS = 64_000_000

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  // Deferred: revoking in the same task can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** The board's title as a file name, with the extension asked for. */
function fileName(title: string, extension: string): string {
  return gladeFilename(title).replace(/\.meadow\.json$/, extension)
}

const grouped = (value: number): string => value.toLocaleString()

/** A byte count as people read one: 840 KB, 18 MB, 1.2 GB. */
function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  const mb = value / (1024 * 1024)
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export function ExportImageDialog({ engine, title, selected, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const toast = useToast()

  const [area, setArea] = useState<Area>(selected > 0 ? 'selection' : 'view')
  const [format, setFormat] = useState<Format>('svg')
  const [density, setDensity] = useState<(typeof DENSITIES)[number]>(8)
  const [progress, setProgress] = useState(0)
  const [background, setBackground] = useState(true)
  const [image, setImage] = useState<SceneImage | null>(null)
  const [state, setState] = useState<'building' | 'ready' | 'empty' | 'saving'>('building')
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])

  // Rebuilt for every change of area or background. Only the latest build is kept: a
  // slow build for a large selection finishing after a quick one must not replace it.
  const build = useRef(0)
  useEffect(() => {
    const ticket = ++build.current
    setState('building')
    void engine
      .exportImage({ area, background, title })
      .then((result) => {
        if (ticket !== build.current) return
        setImage(result)
        setState(result === null ? 'empty' : 'ready')
      })
      .catch(() => {
        if (ticket !== build.current) return
        setImage(null)
        setState('empty')
      })
  }, [engine, area, background, title])

  useEffect(() => {
    if (image === null) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(new Blob([image.svg], { type: 'image/svg+xml' }))
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  // The PNG's size is estimated from two small sample encodes, made once per file and
  // only once somebody looks at PNG; an SVG's is simply its length.
  const [estimate, setEstimate] = useState<((density: number) => number) | null>(null)
  useEffect(() => {
    setEstimate(null)
    if (image === null || format !== 'png') return
    let live = true
    void pngEstimator(image.svg, image.frame)
      .then((estimator) => {
        if (live) setEstimate(() => estimator)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [image, format])

  const pixels = image === null ? null : pngSize(image.frame, density)
  const svgBytes = image === null ? null : new Blob([image.svg]).size

  const download = async (): Promise<void> => {
    if (image === null) return
    if (format === 'svg') {
      save(new Blob([image.svg], { type: 'image/svg+xml' }), fileName(title, '.svg'))
      onClose()
      return
    }
    if (pixels === null) return
    setState('saving')
    setProgress(0)
    try {
      const blob = await rasterizeSvg(image.svg, pixels.width, pixels.height, setProgress)
      save(blob, fileName(title, '.png'))
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not make the image.')
      setState('ready')
    }
  }

  const busy = state === 'building' || state === 'saving'

  return (
    <dialog
      ref={dialogRef}
      className="modal export-modal"
      aria-labelledby="export-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="modal-card export-card">
        <h2 id="export-title">Export as an image</h2>

        <div className={background ? 'export-preview' : 'export-preview transparent'}>
          {state === 'empty' ? (
            <p className="share-note">
              {area === 'selection'
                ? 'Nothing is selected.'
                : 'Nothing is on screen. Move to the part of the glade you want.'}
            </p>
          ) : preview === null ? (
            <p className="share-note">Preparing…</p>
          ) : (
            <img src={preview} alt="What the file will look like" />
          )}
        </div>

        <section className="share-section">
          <h3>What</h3>
          <div className="segmented" role="radiogroup" aria-label="What to export">
            <button
              type="button"
              role="radio"
              aria-checked={area === 'view'}
              onClick={() => setArea('view')}
            >
              What is on screen
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={area === 'selection'}
              disabled={selected === 0}
              title={selected === 0 ? 'Select something on the glade first' : undefined}
              onClick={() => setArea('selection')}
            >
              {selected === 0
                ? 'The selection'
                : `The selection (${selected} ${selected === 1 ? 'object' : 'objects'})`}
            </button>
          </div>
        </section>

        <section className="share-section">
          <h3>Format</h3>
          <div className="segmented" role="radiogroup" aria-label="File format">
            <button
              type="button"
              role="radio"
              aria-checked={format === 'svg'}
              onClick={() => setFormat('svg')}
            >
              SVG
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={format === 'png'}
              onClick={() => setFormat('png')}
            >
              PNG
            </button>
          </div>

          {format === 'svg' ? (
            <p className="share-note">
              Vector, so it stays sharp at any zoom however big the diagram is. The text
              is real text and the fonts travel inside the file.
              {svgBytes !== null && ` ${bytes(svgBytes)}.`}
            </p>
          ) : (
            <>
              <div className="segmented export-small" role="radiogroup" aria-label="Detail">
                {DENSITIES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={density === option}
                    onClick={() => setDensity(option)}
                  >
                    {option}x
                  </button>
                ))}
              </div>
              <p className="share-note">
                {pixels === null
                  ? 'Pixels, for places that only take a picture.'
                  : `${grouped(pixels.width)} × ${grouped(pixels.height)} pixels, ${
                      estimate === null ? 'working out the size…' : `about ${bytes(estimate(density))}.`
                    }`}
                {pixels?.capped === true &&
                  ' That is as large as this export makes one; for more detail, use SVG.'}
                {pixels !== null &&
                  pixels.width * pixels.height > SLOW_PIXELS &&
                  ' An image this size takes a while to make, and some viewers will not open it.'}
              </p>
            </>
          )}
        </section>

        <section className="share-section export-row">
          <h3 id="export-background">Background</h3>
          <div
            className="segmented export-small"
            role="radiogroup"
            aria-labelledby="export-background"
          >
            <button
              type="button"
              role="radio"
              aria-checked={background}
              title="The glade's own colour behind the drawing"
              onClick={() => setBackground(true)}
            >
              Yes
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!background}
              title="See-through, for placing the picture on another page"
              onClick={() => setBackground(false)}
            >
              No
            </button>
          </div>
        </section>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || image === null}
            onClick={() => void download()}
          >
            {state === 'saving'
              ? progress > 0
                ? `Making it… ${Math.round(progress * 100)}%`
                : 'Making it…'
              : 'Download'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
