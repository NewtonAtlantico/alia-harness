import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { CommandInfo, WorkspaceEntry } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { InputHistory, activeMention, activeSlash, applyCommand, applyMention, filterCommands } from '../lib/composer';
import { humanSize } from '../lib/localCommands';
import { baseName } from '../lib/timeline';

const HISTORY_KEY = 'alia.history';
const MAX_FILE_ROWS = 8;
const MAX_COMMAND_ROWS = 20;

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveHistory(items: readonly string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export interface ComposerSubmit {
  text: string;
  /** Absolute paths of files attached with the button or by dropping them. */
  attachments: string[];
}

export interface ComposerProps {
  sessionId: string;
  running: boolean;
  /** Why sending is not possible right now (no model configured), shown in place of the box. */
  blockedReason?: string;
  onOpenSettings: () => void;
  /** Throws (with a readable message) if the message could not be sent; the text is kept. */
  onSubmit: (message: ComposerSubmit) => Promise<void>;
  onStop: () => void;
}

/** Results are kept with the query they answer, so a stale list is never shown (or accepted) for a newer query. */
type MentionState = { query: string | undefined; items: WorkspaceEntry[]; total: number };

/**
 * The message box: multi-line text (Enter sends, Shift+Enter breaks the line), a menu of commands after "/", a menu of
 * the project's files after "@", chips for attached files (button or drag and drop), shell-style history with the
 * arrow keys, and Stop while a run is going.
 */
export function Composer({ sessionId, running, blockedReason, onOpenSettings, onSubmit, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [chips, setChips] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [commandsReady, setCommandsReady] = useState(false);
  const [mentions, setMentions] = useState<MentionState>({ query: undefined, items: [], total: 0 });
  const [suppressed, setSuppressed] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  const history = useRef(new InputHistory(loadHistory()));
  const searchId = useRef(0);
  const listId = useId();

  const slash = activeSlash(text, caret);
  const mention = slash ? undefined : activeMention(text, caret);
  const menuKey = slash ? `/${slash.query}` : mention ? `@${mention.start}:${mention.query}` : undefined;
  const menuOpen = menuKey !== undefined && menuKey !== suppressed;
  const slashRows = slash && menuOpen && commandsReady ? filterCommands(commands, slash.query).slice(0, MAX_COMMAND_ROWS) : [];
  const mentionFresh = !!mention && mentions.query === mention.query;
  const mentionRows = mention && menuOpen && mentionFresh ? mentions.items : [];
  const rows = slash ? slashRows.length : mentionRows.length;
  /** The menu is open but its list is still on the way: keys that would pick from it wait instead of acting on nothing. */
  const loading = menuOpen && (slash ? !commandsReady : !!mention && !mentionFresh);

  // Commands: fetched when the user first types a slash in this conversation (skills may have changed since).
  const wantsCommands = !!slash;
  useEffect(() => {
    if (!wantsCommands) return;
    let live = true;
    setCommandsReady(false);
    window.alia.request('commands.list', { sessionId }).then((c) => live && (setCommands(c), setCommandsReady(true)), () => {});
    return () => {
      live = false;
    };
  }, [wantsCommands, sessionId]);

  // Files: searched as the user types after an "@".
  const mentionQuery = mention && menuOpen ? mention.query : undefined;
  useEffect(() => {
    if (mentionQuery === undefined) return;
    const id = ++searchId.current;
    const timer = setTimeout(() => {
      window.alia
        .request('files.search', { sessionId, query: mentionQuery, limit: MAX_FILE_ROWS })
        .then((r) => id === searchId.current && setMentions({ query: mentionQuery, items: r.matches, total: r.total }), () => id === searchId.current && setMentions({ query: mentionQuery, items: [], total: 0 }));
    }, 80);
    return () => clearTimeout(timer);
  }, [mentionQuery, sessionId]);

  useEffect(() => setSelected(0), [menuKey]);

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // Files dropped on the window (reported by the preload for a genuine drop).
  const addChips = useCallback((paths: string[]) => {
    setChips((cur) => [...cur, ...paths.filter((p) => !cur.includes(p))]);
    box.current?.focus();
  }, []);
  useEffect(() => window.alia.onMessage((m) => m.kind === 'files_dropped' && addChips(m.paths)), [addChips]);

  // A highlight while files are dragged over the window.
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => has(e) && (depth++, setDropping(true));
    const leave = (e: DragEvent) => has(e) && (depth = Math.max(0, depth - 1)) === 0 && setDropping(false);
    const end = () => {
      depth = 0;
      setDropping(false);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
    };
  }, []);

  useEffect(() => {
    if (!blockedReason) box.current?.focus();
  }, [sessionId, blockedReason]);

  const change = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCaret(e.target.selectionStart);
    setError(undefined);
    history.current.reset();
  };
  const syncCaret = () => box.current && setCaret(box.current.selectionStart);

  const place = (next: { text: string; caret: number }) => {
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const accept = (how: 'complete' | 'drill') => {
    if (slash && slashRows[selected]) return place(applyCommand(text, slash, slashRows[selected]));
    if (mention && mentionRows[selected]) return place(applyMention(text, mention, mentionRows[selected], how));
  };

  const send = async () => {
    const message = text.trim();
    if (!message && chips.length === 0) return;
    if (running || sending) return setError(t.composer.waitOrStop);
    setSending(true);
    setError(undefined);
    try {
      await onSubmit({ text: message, attachments: chips });
      if (message) {
        history.current.push(message);
        saveHistory(history.current.entries);
      }
      setText('');
      setCaret(0);
      setChips([]);
    } catch (e) {
      setError(t.composer.sendFailed(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')));
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // an input method is still composing
    const open = menuOpen && rows > 0;

    // The list is still loading: Tab and Enter wait for it rather than sending half a mention or moving focus away.
    if (loading && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault();
      return;
    }

    // A command that is already typed in full is sent by Enter, not completed again.
    const complete = !!slash && !!slashRows[selected] && slashRows[selected].name.toLowerCase() === slash.query.toLowerCase();

    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => (e.key === 'ArrowDown' ? (i + 1) % rows : (i - 1 + rows) % rows));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        return accept('drill');
      }
      if (e.key === 'Enter' && !e.shiftKey && !complete) {
        e.preventDefault();
        return accept('complete');
      }
    }
    if (menuOpen && e.key === 'Escape') {
      e.preventDefault();
      return setSuppressed(menuKey);
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }

    // History: Up from the first line of the box, Down from the last (inside a multi-line text the arrows move the caret).
    const el = box.current;
    if (e.key === 'ArrowUp' && el && el.selectionStart === el.selectionEnd && !text.slice(0, el.selectionStart).includes('\n')) {
      const older = history.current.prev(text);
      if (older !== undefined) {
        e.preventDefault();
        place({ text: older, caret: older.length });
      }
    } else if (e.key === 'ArrowDown' && el && history.current.browsing && el.selectionStart === el.selectionEnd && !text.slice(el.selectionEnd).includes('\n')) {
      const newer = history.current.next();
      if (newer !== undefined) {
        e.preventDefault();
        place({ text: newer, caret: newer.length });
      }
    }
  };

  const attach = async () => {
    try {
      const { paths } = await window.alia.request('attachments.pick', {});
      if (paths.length > 0) addChips(paths);
    } catch (e) {
      setError(t.composer.sendFailed(String((e as Error)?.message ?? e)));
    }
  };

  if (blockedReason) {
    return (
      <div className="composer blocked" role="note">
        <p>{blockedReason}</p>
        <button type="button" className="btn primary" onClick={onOpenSettings}>
          {t.composer.openSettings}
        </button>
      </div>
    );
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <form className={`composer ${dropping ? 'dropping' : ''}`} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {dropping && <div className="drop-overlay" aria-hidden="true">{t.composer.drop}</div>}

      {chips.length > 0 && (
        <ul className="chips" aria-label={t.composer.attachments}>
          {chips.map((p) => (
            <li key={p} className="chip file" title={p}>
              <span>{baseName(p)}</span>
              <button type="button" aria-label={t.composer.removeAttachment(baseName(p))} onClick={() => setChips(chips.filter((x) => x !== p))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {menuOpen && (slash || mention) && (
        <ul id={listId} className="composer-menu" role={rows > 0 ? 'listbox' : 'presentation'} aria-label={rows > 0 ? (slash ? t.composer.slashMenu : t.composer.mentionMenu) : undefined} data-testid="composer-menu">
          {slash &&
            slashRows.map((c, i) => (
              <li key={c.name} id={optionId(i)} role="option" aria-selected={i === selected} className={i === selected ? 'selected' : ''} onMouseDown={(e) => { e.preventDefault(); setSelected(i); place(applyCommand(text, slash, c)); }}>
                <code>/{c.name}</code>
                <span className="hint">{c.description}</span>
                {c.kind === 'skill' && <span className="chip small">{t.composer.skillTag}</span>}
              </li>
            ))}
          {mention &&
            mentionRows.map((entry, i) => (
              <li key={entry.path} id={optionId(i)} role="option" aria-selected={i === selected} className={i === selected ? 'selected' : ''} onMouseDown={(e) => { e.preventDefault(); setSelected(i); place(applyMention(text, mention, entry, 'complete')); }}>
                <code>{entry.isDir ? `${entry.path}/` : entry.path}</code>
                {entry.isDir ? (
                  <>
                    <span className="chip small">{t.composer.wholeFolder}</span>
                    <span className="hint">{t.composer.items(entry.childCount)}</span>
                  </>
                ) : (
                  <span className="hint">{humanSize(entry.size)}</span>
                )}
              </li>
            ))}
          {rows === 0 && !loading && (
            <li className="hint empty" role="presentation">
              {mention ? t.composer.noMatches : t.composer.local.none}
            </li>
          )}
          {mention && mentionFresh && mentions.total > mentionRows.length && <li className="hint" role="presentation">{t.composer.moreMatches(mentions.total - mentionRows.length)}</li>}
          <li className="hint foot" role="presentation">
            {mention && mentionRows[selected]?.isDir ? t.composer.folderHint : t.composer.menuHint}
          </li>
        </ul>
      )}
      <span className="sr-only" role="status">{menuOpen && (slash || mention) ? t.composer.results(rows) : ''}</span>

      <div className="composer-box">
        <button type="button" className="icon-btn attach" aria-label={t.composer.attach} title={t.composer.attach} onClick={attach}>
          📎
        </button>
        <textarea
          ref={box}
          rows={1}
          value={text}
          aria-label={t.composer.label}
          placeholder={t.composer.placeholder}
          role="combobox"
          aria-expanded={menuOpen && rows > 0}
          aria-controls={menuOpen && (slash || mention) ? listId : undefined}
          aria-activedescendant={menuOpen && rows > 0 ? optionId(selected) : undefined}
          aria-autocomplete="list"
          spellCheck
          onChange={change}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
        />
        {running ? (
          <button type="button" className="btn danger stop" onClick={onStop} title={t.composer.stopTitle}>
            ■ {t.composer.stop}
          </button>
        ) : (
          <button type="submit" className="btn primary send" disabled={sending || (!text.trim() && chips.length === 0)}>
            {t.composer.send}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert" data-testid="composer-error">
          {error}
        </p>
      )}
      <p className="hint composer-hint">{t.composer.hint}</p>
    </form>
  );
}
