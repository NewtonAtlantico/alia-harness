import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../i18n/pt-BR';

/**
 * Model and document text rendered as markdown, safely:
 *  - raw HTML is never rendered as HTML (it shows as text), so a malicious PDF or answer cannot inject UI;
 *  - a link opens only if it is https, and only through the app (main shows a confirmation with the full address);
 *    any other link is shown as plain text with its address;
 *  - images are never loaded (the page's policy would refuse them anyway): the alt text is shown.
 */
function Link({ href, children }: ComponentProps<'a'>) {
  const url = href ?? '';
  if (!url.startsWith('https://')) {
    return (
      <span className="link-blocked" title={t.timeline.link.onlyHttps}>
        {children}
        {url ? <span className="hint"> ({url})</span> : null}
      </span>
    );
  }
  return (
    <a
      href={url}
      title={url}
      aria-label={typeof children === 'string' ? `${children} — ${t.timeline.link.open(url)}` : undefined}
      onClick={(e) => {
        e.preventDefault();
        void window.alia.request('app.openExternal', { url }).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

function Image({ alt }: ComponentProps<'img'>) {
  return <span className="img-alt">{t.timeline.image(alt ?? '')}</span>;
}

function Table({ children }: { children?: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: Link, img: Image, table: Table }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
