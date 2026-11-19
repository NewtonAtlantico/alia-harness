import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal dialog the page draws itself: labelled, focus moves into it and is kept there, Esc cancels, and focus
 * goes back to where it was when it closes.
 */
export function Dialog({ labelledBy, onCancel, children }: { labelledBy: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled'));
    (root.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.current();
      } else if (e.key === 'Tab') {
        const items = focusable();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to where it was. A row's buttons only show while the row has the focus, so they cannot take it back until the row
      // does: focus the row first (that shows them), then the button.
      if (previous?.isConnected) {
        previous.focus?.();
        if (document.activeElement !== previous) {
          previous.closest<HTMLElement>('.conv')?.querySelector<HTMLElement>('.conv-main')?.focus();
          previous.focus?.();
        }
      }
    };
  }, []);

  return (
    <div className="dialog-backdrop">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}
