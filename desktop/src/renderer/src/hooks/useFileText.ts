import { useEffect, useState } from 'react';

export type FileText = { state: 'loading' } | { state: 'ready'; text: string; truncated: boolean } | { state: 'missing' } | { state: 'none' };

/** The text of a project file (through the read-only preview), read again when the path or `refreshKey` changes. */
export function useFileText(sessionId: string, path: string | undefined, refreshKey?: unknown): FileText {
  const [result, setResult] = useState<FileText>({ state: path ? 'loading' : 'none' });
  useEffect(() => {
    if (!path) return setResult({ state: 'none' });
    let current = true;
    setResult({ state: 'loading' });
    window.alia
      .request('files.preview', { sessionId, path })
      .then((p) => current && setResult(p.text !== undefined ? { state: 'ready', text: p.text, truncated: !!p.truncated } : { state: 'missing' }))
      .catch(() => current && setResult({ state: 'missing' }));
    return () => {
      current = false;
    };
  }, [sessionId, path, refreshKey]);
  return result;
}
