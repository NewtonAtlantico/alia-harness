import type { AppCommand } from '../shared/ipc';

export interface KeyInput {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * The app-level shortcuts, decided from the raw key event. The window has no native frame, so the menu bar is not
 * drawn and relying on menu accelerators alone is not safe; main listens for these keys itself.
 * Ctrl N new conversation, Ctrl O open a project, Ctrl , settings, Ctrl J show or hide the panel (Cmd on macOS).
 */
export function commandForInput(input: KeyInput): AppCommand | undefined {
  if (input.type !== 'keyDown') return undefined;
  if (!(input.control || input.meta) || input.alt || input.shift) return undefined;
  switch (input.key.toLowerCase()) {
    case 'n':
      return 'new_conversation';
    case 'o':
      return 'open_project';
    case ',':
      return 'open_settings';
    case 'j':
      return 'toggle_panel';
    default:
      return undefined;
  }
}
