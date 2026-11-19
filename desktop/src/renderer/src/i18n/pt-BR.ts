/**
 * Every string the interface shows lives here (pt-BR is the only language for v1), so another language is a new
 * catalog and not a hunt through components. Agent-facing prompts are not here; they stay in English.
 */
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
};
