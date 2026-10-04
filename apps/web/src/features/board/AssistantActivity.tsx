/**
 * What an assistant has done to this glade.
 *
 * Read-only, and deliberately so. Nothing in here changes the glade: it is the one
 * place a person can see what a machine did on their behalf, and a panel that could
 * also undo things would be a different feature with a different set of questions about
 * who may press it.
 *
 * A row per operation, newest first. The pair that matters is `requested` against
 * `accepted`: they differ when a plan named objects that were no longer there, which is
 * what a model working from a stale reading of a glade looks like from the outside. A
 * refusal or a failure carries its reason, and those are the rows worth reading, so they
 * are marked rather than left to blend in.
 *
 * The trail is readable by a signed-in person with access to this glade and not by an
 * access token, so an assistant cannot inspect, or work around, the record of itself.
 */

import { useEffect, useRef, useState } from 'react'

import * as api from '../../lib/api'
import type { McpEvent } from '../../lib/api'
import { asked, describe, took, when } from './assistantActivity'
import { IconAlert, IconCheck, IconClock } from '../../ui/icons'

export function AssistantActivity({
  boardId,
  noun,
  onClose,
}: {
  boardId: string
  noun: string
  onClose: () => void
}): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [events, setEvents] = useState<McpEvent[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])

  useEffect(() => {
    let live = true
    api
      .listMcpEvents(boardId)
      .then((rows) => {
        if (live) setEvents(rows)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [boardId])

  return (
    <dialog
      ref={dialogRef}
      className="modal activity-modal"
      aria-labelledby="activity-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="modal-card activity-card">
        <h2 id="activity-title">Assistant activity</h2>

        {failed && <p className="modal-body">That could not be read just now.</p>}

        {!failed && events === null && <p className="modal-body">Reading…</p>}

        {!failed && events !== null && events.length === 0 && (
          <p className="modal-body">
            No assistant has changed this {noun}. When one does, every change it makes is
            listed here.
          </p>
        )}

        {events !== null && events.length > 0 && (
          <ul className="activity-list">
            {events.map((event) => (
              <li key={event.id} className={`activity-row ${event.outcome}`}>
                <span className="activity-mark" aria-hidden="true">
                  {event.outcome === 'applied' ? <IconCheck size={14} /> : <IconAlert size={14} />}
                </span>
                <span className="activity-what">
                  {event.outcome === 'applied' ? describe(event) : `Refused to ${asked(event)}`}
                  {/* Only when the two disagree. Printing "3 of 3" on every row would
                      bury the one row where it is 1 of 4. */}
                  {event.outcome === 'applied' && event.accepted !== event.requested && (
                    <span className="activity-gap">
                      {' '}
                      ({event.accepted} of {event.requested} asked for)
                    </span>
                  )}
                  {event.reason !== null && <span className="activity-why">{event.reason}</span>}
                </span>
                <span className="activity-when" title={new Date(event.created_at).toLocaleString()}>
                  <IconClock size={12} aria-hidden="true" />
                  {when(event.created_at)}
                  <span className="activity-took"> · {took(event.duration_ms)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
