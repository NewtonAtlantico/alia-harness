/** Text main shows (menus, native dialogs). pt-BR only for v1; the renderer has its own catalog. */
export const mainStrings = {
  appName: 'alia Harness',
  menu: {
    file: 'Arquivo',
    newConversation: 'Nova conversa',
    openProject: 'Abrir pasta do projeto…',
    settings: 'Configurações',
    quit: 'Sair',
    edit: 'Editar',
    view: 'Exibir',
    togglePanel: 'Mostrar ou ocultar o painel',
    window: 'Janela',
    help: 'Ajuda',
    about: 'Sobre o alia Harness',
  },
  dialogs: {
    pickFolder: 'Escolher pasta do projeto',
    openLinkTitle: 'Abrir este link no navegador?',
    openLinkDetail: (url: string) => `${url}\n\nO endereço será aberto fora do aplicativo.`,
    open: 'Abrir',
    cancel: 'Cancelar',
    aboutDetail: (version: string) => `Versão ${version}`,
  },
};
