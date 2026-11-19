import { useCallback, useEffect, useState } from 'react';
import type { DirectoryEntry, FilePreview } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { humanSize } from '../lib/localCommands';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

type Listing = DirectoryEntry[] | 'loading' | { error: string };

function previewNote(p: FilePreview): string | undefined {
  switch (p.kind) {
    case 'binary':
      return p.note && !/^extension|NUL bytes/.test(p.note) ? p.note : t.panel.files.binary;
    case 'too_large':
      return t.panel.files.tooLarge;
    case 'missing':
      return t.panel.files.missing;
    case 'not_a_file':
      return t.panel.files.notAFile;
    default:
      return undefined;
  }
}

/**
 * The project's folders and files, one level at a time as they are opened, with a read-only look at a file. Documents show
 * the text the agent would read. Nothing here can change a file.
 */
export function FilesTab({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<FilePreview | 'loading' | { error: string }>();
  const api = window.alia.request;

  const list = useCallback(
    async (dir: string) => {
      setListings((cur) => ({ ...cur, [dir]: cur[dir] && Array.isArray(cur[dir]) ? cur[dir] : 'loading' }));
      try {
        const { entries } = await api('files.children', { sessionId, dir });
        setListings((cur) => ({ ...cur, [dir]: entries }));
      } catch (err) {
        setListings((cur) => ({ ...cur, [dir]: { error: errorText(err) } }));
      }
    },
    [api, sessionId]
  );

  // The root, and every open folder again when the project may have changed (the agent wrote something).
  useEffect(() => {
    void list('');
    for (const dir of expanded) void list(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, refreshKey]);

  const loadPreview = useCallback(
    async (path: string) => {
      setSelected(path);
      setPreview('loading');
      try {
        setPreview(await api('files.preview', { sessionId, path }));
      } catch (err) {
        setPreview({ error: errorText(err) });
      }
    },
    [api, sessionId]
  );

  const toggleDir = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      void list(dir);
    }
    setExpanded(next);
  };

  const render = (dir: string, depth: number) => {
    const listing = listings[dir];
    if (listing === undefined || listing === 'loading') return <li className="hint tree-note" style={{ paddingLeft: depth * 14 + 8 }}>{t.panel.files.loading}</li>;
    if (!Array.isArray(listing)) return <li className="error tree-note" style={{ paddingLeft: depth * 14 + 8 }}>{t.panel.files.failed(listing.error)}</li>;
    if (listing.length === 0) return <li className="hint tree-note" style={{ paddingLeft: depth * 14 + 8 }}>{t.panel.files.empty}</li>;
    return listing.map((e) => (
      <li key={e.path}>
        {e.isDir ? (
          <>
            <button type="button" className="tree-row dir" style={{ paddingLeft: depth * 14 + 8 }} aria-expanded={expanded.has(e.path)} aria-label={expanded.has(e.path) ? t.panel.files.close(e.name) : t.panel.files.open(e.name)} onClick={() => toggleDir(e.path)}>
              <span aria-hidden="true">{expanded.has(e.path) ? '▾' : '▸'}</span> <span className="name">{e.name}/</span>
              <span className="hint">{t.panel.files.items(e.childCount)}</span>
            </button>
            {expanded.has(e.path) && <ul>{render(e.path, depth + 1)}</ul>}
          </>
        ) : (
          <button type="button" className={`tree-row file ${selected === e.path ? 'selected' : ''}`} style={{ paddingLeft: depth * 14 + 22 }} aria-current={selected === e.path ? 'true' : undefined} onClick={() => void loadPreview(e.path)}>
            <span className="name">{e.name}</span>
            <span className="hint">{humanSize(e.size)}</span>
          </button>
        )}
      </li>
    ));
  };

  return (
    <div className="files-tab">
      <ul className="tree" aria-label={t.panel.files.label} data-testid="file-tree">
        {render('', 0)}
      </ul>
      <section className="preview" aria-label={t.panel.files.preview} data-testid="file-preview">
        {!selected && <p className="hint">{t.panel.files.pick}</p>}
        {selected && preview === 'loading' && <p className="hint">{t.panel.files.loading}</p>}
        {selected && preview && preview !== 'loading' && 'error' in preview && <p className="error">{t.panel.files.failed(preview.error)}</p>}
        {selected && preview && preview !== 'loading' && !('error' in preview) && (
          <>
            <p className="preview-head">
              <code>{preview.path}</code> <span className="hint">{humanSize(preview.size)} · {t.panel.files.readOnly}</span>
            </p>
            {previewNote(preview) && <p className="hint">{previewNote(preview)}</p>}
            {preview.kind === 'document' && <p className="hint">{t.panel.files.document}</p>}
            {preview.note && preview.kind === 'document' && <p className="hint">{preview.note}</p>}
            {preview.text !== undefined && <pre className="preview-text" tabIndex={0}>{preview.text}</pre>}
            {preview.truncated && <p className="hint">{t.panel.files.truncated}</p>}
          </>
        )}
      </section>
    </div>
  );
}
