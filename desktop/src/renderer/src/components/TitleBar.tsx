import { useEffect, useState } from 'react';
import logoAlia from '../assets/logo-alia.png';
import { t } from '../i18n/pt-BR';

/** The window has no native frame: this bar is the title bar. Dragging it moves the window; the buttons call main. */
export function TitleBar() {
  const [version, setVersion] = useState('');
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.alia.request('app.info', {}).then((info) => setVersion(info.version));
    void window.alia.request('window.state', {}).then((s) => setMaximized(s.maximized));
    return window.alia.onMessage((m) => {
      if (m.kind === 'window_state') setMaximized(m.maximized);
    });
  }, []);

  const call = (name: 'window.minimize' | 'window.toggleMaximize' | 'window.close') => () => void window.alia.request(name, {});

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <img src={logoAlia} alt="alia" height={22} />
        <span className="titlebar-version">{version ? t.titleBar.version(version) : ''}</span>
      </div>
      <div className="titlebar-controls">
        <button type="button" aria-label={t.titleBar.minimize} title={t.titleBar.minimize} onClick={call('window.minimize')}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button type="button" aria-label={maximized ? t.titleBar.restore : t.titleBar.maximize} title={maximized ? t.titleBar.restore : t.titleBar.maximize} onClick={call('window.toggleMaximize')}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5h6v6h-6zM2.5 2.5V.5h7v7h-1" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          )}
        </button>
        <button type="button" className="close" aria-label={t.titleBar.close} title={t.titleBar.close} onClick={call('window.close')}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </header>
  );
}
