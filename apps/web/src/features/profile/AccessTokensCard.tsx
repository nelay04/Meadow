import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { IconCopy, IconKey } from "../../ui/icons";
import { absoluteTime, relativeTime } from "../../ui/time";
import { useConfirm } from "../../ui/ConfirmDialog";
import { useToast } from "../../ui/Toaster";
import * as api from "../../lib/api";
import { ApiError } from "../../lib/api";
import type { AccessToken, CreatedAccessToken } from "../../lib/api";
import { copy } from "../../lib/clipboard";

const SCOPES: { id: AccessToken["scope"]; label: string }[] = [
  { id: "read", label: "Read only" },
  { id: "write", label: "Read and edit" },
];

/** Days, or null for never. Never is offered and is not the default. */
const LIFETIMES: { days: number | null; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
  { days: null, label: "Never" },
];

/** "12 Dec 2026". `relativeTime` only speaks about the past, and an expiry is ahead. */
function shortDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Personal access tokens, for AI assistants and scripts.
 *
 * Its own component because the page it sits on is already long, and because this card
 * is the only one holding a secret: the raw token lives in `created` for as long as the
 * person needs to copy it and is dropped the moment they dismiss it. It is never written
 * anywhere else, and the list the server sends back cannot reproduce it.
 */
export function AccessTokensCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<AccessToken["scope"]>("read");
  const [lifetime, setLifetime] = useState<number | null>(90);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    try {
      setTokens(await api.listAccessTokens());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    setCreating(true);
    try {
      const token = await api.createAccessToken({
        name: trimmed,
        scope,
        ...(lifetime === null ? {} : { expires_in_days: lifetime }),
      });
      setCreated(token);
      setName("");
      await reload();
    } catch (caught) {
      toast.error(
        caught instanceof ApiError && caught.status === 409
          ? "You have as many tokens as an account may hold. Revoke one first."
          : "Could not create the token.",
      );
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: AccessToken) => {
    const ok = await confirm({
      title: `Revoke ${token.name}?`,
      body:
        "Anything using it stops working straight away, including a board it has open " +
        "right now. Nothing on your glades changes.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!ok) return;
    setRevoking(token.id);
    try {
      await api.revokeAccessToken(token.id);
      if (created?.id === token.id) setCreated(null);
      toast.success(`${token.name} was revoked.`);
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 404)) {
        toast.error("Could not revoke that token.");
      }
    } finally {
      setRevoking(null);
      await reload();
    }
  };

  const copyCreated = async () => {
    if (created === null) return;
    if (await copy(created.token)) toast.success("Token copied.");
    else toast.error("Could not copy. Select the token and copy it by hand.");
  };

  return (
    <section className="card">
      <h2>Access tokens</h2>
      <p className="hint">
        For AI assistants and scripts that read or edit your glades through the
        Meadow MCP server. A token acts as you, and can never do more than you
        can.
      </p>

      {created !== null && (
        <div className="token-created" role="status">
          <p>
            <strong>Copy {created.name} now.</strong> This is the only time it
            is shown.
          </p>
          <div className="token-secret">
            <code>{created.token}</code>
            <button
              type="button"
              className="primary"
              onClick={() => void copyCreated()}
            >
              <IconCopy size={16} />
              Copy
            </button>
          </div>
          <button
            type="button"
            className="ghost profile-inline-action"
            onClick={() => setCreated(null)}
          >
            I have saved it
          </button>
        </div>
      )}

      <form className="token-form" onSubmit={create} noValidate>
        <div className="profile-row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="What will use it, e.g. Claude Code on my laptop"
            aria-label="Token name"
          />
          <button
            type="submit"
            className="primary"
            disabled={creating || name.trim() === ""}
          >
            {creating ? "Creating..." : "Create token"}
          </button>
        </div>
        <div className="token-options">
          <div
            className="theme-choices"
            role="radiogroup"
            aria-label="What the token may do"
          >
            {SCOPES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={scope === choice.id}
                className={
                  scope === choice.id ? "theme-choice active" : "theme-choice"
                }
                onClick={() => setScope(choice.id)}
              >
                <span>{choice.label}</span>
              </button>
            ))}
          </div>
          <div
            className="theme-choices"
            role="radiogroup"
            aria-label="When the token expires"
          >
            {LIFETIMES.map((choice) => (
              <button
                key={choice.label}
                type="button"
                role="radio"
                aria-checked={lifetime === choice.days}
                className={
                  lifetime === choice.days
                    ? "theme-choice active"
                    : "theme-choice"
                }
                onClick={() => setLifetime(choice.days)}
              >
                <span>{choice.label}</span>
              </button>
            ))}
          </div>
        </div>
      </form>

      {tokens === null ? (
        failed ? (
          <p className="faint">
            Could not load your tokens. Reload the page to try again.
          </p>
        ) : (
          <p className="faint">Loading...</p>
        )
      ) : tokens.length === 0 ? (
        <p className="hint">No tokens yet.</p>
      ) : (
        <ul className="session-list">
          {tokens.map((token) => (
            <li key={token.id} className="session">
              <span className="session-icon" aria-hidden="true">
                <IconKey size={20} />
              </span>
              <span className="session-text">
                <span className="session-title">{token.name}</span>
                <span className="session-meta faint">
                  <span>
                    <code>{token.prefix}...</code>
                  </span>
                  <span>
                    {token.scope === "write" ? "Read and edit" : "Read only"}
                  </span>
                  {token.board_ids !== null && (
                    <span>
                      {token.board_ids.length === 1
                        ? "1 glade"
                        : `${token.board_ids.length} glades`}
                    </span>
                  )}
                  <span
                    title={
                      token.last_used_at === null
                        ? undefined
                        : absoluteTime(token.last_used_at)
                    }
                  >
                    {token.last_used_at === null
                      ? "Never used"
                      : `Used ${relativeTime(token.last_used_at)}`}
                  </span>
                  <span
                    title={
                      token.expires_at === null
                        ? undefined
                        : absoluteTime(token.expires_at)
                    }
                  >
                    {token.expires_at === null
                      ? "Never expires"
                      : `Expires ${shortDate(token.expires_at)}`}
                  </span>
                </span>
              </span>
              <button
                type="button"
                className="danger profile-connect"
                disabled={revoking === token.id}
                onClick={() => void revoke(token)}
              >
                {revoking === token.id ? "Revoking..." : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
