/**
 * Every string the interface shows lives here (pt-BR is the only language for v1), so another language is a new
 * catalog and not a hunt through components. Agent-facing prompts are not here; they stay in English.
 */
import type { ConnectionTestResult, PermissionMode } from '../../../shared/ipc';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const t = {
  appName: 'alia Harness',
  titleBar: {
    version: (v: string) => `Harness v${v}`,
    minimize: 'Minimizar',
    maximize: 'Maximizar',
    restore: 'Restaurar',
    close: 'Fechar',
  },
  engine: {
    connecting: 'Conectando ao motor…',
    unavailable: (why: string) => `Motor indisponível: ${why}`,
    active: (pid: number, node: string, stages: number) => `Motor ativo (processo ${pid}, Node ${node}, ${stages} etapas no core).`,
  },
  home: {
    openSettings: 'Configurações',
    needsSetup: 'Falta configurar o acesso aos modelos antes de começar uma conversa.',
    configure: 'Configurar agora',
  },
  common: {
    loading: 'Carregando…',
    errorGeneric: (why: string) => `Algo deu errado: ${why}`,
  },
  settings: {
    title: 'Configurações',
    back: 'Voltar',
    save: 'Salvar',
    saving: 'Salvando…',
    saved: 'Configurações salvas.',
    discard: 'Descartar alterações',
    unsaved: 'Há alterações não salvas.',
    firstRun: {
      title: 'Vamos configurar o acesso aos modelos',
      body: 'Informe o endereço do serviço e a chave de API, ou importe a configuração que você já usa no terminal.',
    },
    import: {
      found: (path: string, models: number) => `Encontramos uma configuração existente em ${path} (${plural(models, 'modelo', 'modelos')}).`,
      button: 'Importar',
      fromFile: 'Importar de um arquivo…',
      done: (models: number, key: boolean) => `Configuração importada: ${plural(models, 'modelo', 'modelos')}${key ? ' e a chave de API' : ''}.`,
      noKey: 'A chave de API não veio junto: informe-a em Conexão.',
      failed: (why: string) => `Não foi possível importar: ${why}`,
    },
    connection: {
      title: 'Conexão',
      endpoint: 'Endereço do serviço (URL)',
      endpointHint: 'Exemplo: https://chat.alia.atlantico.com.br/api/',
      apiKey: 'Chave de API',
      keySaved: 'Chave salva e protegida pelo Windows.',
      keyReplace: 'Substituir chave',
      keyRemove: 'Remover chave',
      keyCancel: 'Manter a chave atual',
      keyPlaceholder: 'Cole a chave aqui',
      keyNote: 'A chave é guardada com a criptografia do sistema e nunca é exibida de novo.',
      noSecureStorage: 'Este computador não permite guardar a chave com segurança, então ela não pode ser salva. O aplicativo nunca grava a chave em texto simples.',
      test: 'Testar conexão',
      testing: 'Testando…',
      ok: (models: number) => `Conexão estabelecida. O serviço informou ${plural(models, 'modelo', 'modelos')}.`,
      reasons: {
        unauthorized: 'A chave de API foi recusada. Confira se ela está correta e ativa.',
        not_found: 'O serviço não respondeu neste endereço. Confira a URL (ela costuma terminar em /api/ ou /v1/).',
        unreachable: 'Não foi possível alcançar o serviço. Verifique a rede, a VPN e o endereço.',
        timeout: 'O serviço demorou demais para responder.',
        other: 'Não foi possível testar a conexão.',
      } satisfies Record<NonNullable<ConnectionTestResult['reason']>, string>,
      needKey: 'Informe a chave de API para testar.',
      available: 'Modelos disponíveis no serviço',
      addModel: 'Adicionar',
      alreadyAdded: 'já configurado',
    },
    models: {
      title: 'Modelos',
      hint: 'Os modelos que podem ser escolhidos nas conversas. A janela de contexto é o limite de tokens que o aplicativo respeita.',
      id: 'Identificador',
      name: 'Nome',
      context: 'Contexto (tokens)',
      add: 'Adicionar modelo',
      remove: (name: string) => `Remover o modelo ${name}`,
      newId: 'novo-modelo',
    },
    profile: {
      title: 'Perfil',
      name: 'Seu nome',
      nameHint: 'Aparece na saudação e como responsável quando você adia uma pergunta.',
      organization: 'Organização',
    },
    permissions: {
      title: 'Aprovação de comandos',
      hint: 'Vale para as próximas conversas. Comandos destrutivos sempre pedem sua aprovação, exceto no modo automático.',
      modes: {
        'ask-commands': { label: 'Perguntar antes de cada comando', hint: 'Recomendado. Comandos já permitidos neste projeto não perguntam de novo.' },
        'ask-dangerous': { label: 'Perguntar só para comandos perigosos', hint: 'Comandos comuns rodam sem pedir; os destrutivos pedem aprovação.' },
        auto: { label: 'Automático (sem perguntas)', hint: 'Nada pede aprovação. Use apenas em pastas que você pode perder.' },
      } satisfies Record<PermissionMode, { label: string; hint: string }>,
      allowlist: 'Comandos permitidos',
      allowlistHint: 'Comandos que você escolheu "Sempre permitir neste projeto". Você pode revogar qualquer um.',
      project: 'Projeto',
      noProjects: 'Nenhum projeto aberto ainda.',
      none: 'Nenhum comando permitido neste projeto.',
      remove: 'Remover',
      removeRule: (command: string) => `Remover a permissão do comando ${command}`,
      prefix: 'prefixo',
    },
    errors: {
      endpoint: 'Informe um endereço http ou https, sem usuário e senha.',
      noModels: 'Configure pelo menos um modelo.',
      modelId: 'Todo modelo precisa de um identificador.',
      duplicateId: (id: string) => `O identificador "${id}" aparece mais de uma vez.`,
      context: 'A janela de contexto deve ser um número a partir de 1.000.',
      keyShort: 'Essa chave parece curta demais.',
    },
  },
};
