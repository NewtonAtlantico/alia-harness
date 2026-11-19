import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { AppCommand } from '../shared/ipc';
import { mainStrings } from './strings';

export interface MenuOptions {
  /** Sends a command to the page (it decides what it means on the current screen). */
  send: (command: AppCommand) => void;
  quit: () => void;
  about: () => void;
  /** Reload and developer tools only while developing. */
  developer: boolean;
}

/**
 * The application menu. The window has no native frame, so the menu bar is not drawn, but the shortcuts work
 * everywhere in the app (Ctrl N for a new conversation, and so on).
 */
export function buildMenu(options: MenuOptions): Menu {
  const s = mainStrings.menu;
  const template: MenuItemConstructorOptions[] = [
    {
      label: s.file,
      submenu: [
        { id: 'new-conversation', label: s.newConversation, accelerator: 'CmdOrCtrl+N', click: () => options.send('new_conversation') },
        { id: 'open-project', label: s.openProject, accelerator: 'CmdOrCtrl+O', click: () => options.send('open_project') },
        { type: 'separator' },
        { id: 'open-settings', label: s.settings, accelerator: 'CmdOrCtrl+,', click: () => options.send('open_settings') },
        { type: 'separator' },
        { id: 'quit', label: s.quit, accelerator: 'CmdOrCtrl+Q', click: options.quit },
      ],
    },
    { label: s.edit, submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: s.view,
      submenu: [
        { id: 'toggle-panel', label: s.togglePanel, accelerator: 'CmdOrCtrl+J', click: () => options.send('toggle_panel') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(options.developer ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    { label: s.window, submenu: [{ role: 'minimize' }, { role: 'close' }] },
    { label: s.help, submenu: [{ id: 'about', label: s.about, click: options.about }] },
  ];
  return Menu.buildFromTemplate(template);
}
