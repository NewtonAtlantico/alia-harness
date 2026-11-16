# Artefatos dos indicadores físicos

O indicador físico é a comprovação material, tangível ou documental de que uma meta ou etapa do
projeto foi concluída. **A entrega é o próprio artefato** (o documento completo), não uma tabela
que diz se ele está pronto. Os artefatos **variam por projeto**: a fonte mais confiável é a coluna
"Indicador físico de entrega" do PT, e o gerente do projeto decide o que mais é necessário.

Para cada artefato: um **esqueleto fixo de seções** e o **tempo verbal da fase** em que ele nasce.
Escreva só o que o PT, o repositório, o Jira e as evidências sustentam, e use os nomes do PT.

## Convenções comuns aos documentos técnicos

- Capa com título, nome do projeto, classificação ("RESERVADO"), responsável e elaboradores
  (nome e e-mail), e a linha de direitos reservados.
- Cabeçalho com logo, "Nome do documento  N / TOTAL" e rodapé de direitos reservados (aplicados em todas as páginas por `scripts/build_docx.py`).
- Índice, e depois a seção **1 Histórico** (data · versão · responsável · alteração), versão `A.01`
  na criação.
- Seção **2 Introdução** (motivação, objetivos, público-alvo, referências) como cabeçalho padrão.
  A referência obrigatória é o PT, com número e Termo de Parceria; cite também os outros documentos
  do projeto que o artefato referencia (ex.: arquitetura).
- Confira que o **índice bate com o corpo**: o documento de referência trouxe um índice defasado
  (títulos de escopo que não existem no corpo). O corpo é o que vale.
- Sem credenciais, hashes de senha, IPs internos ou dados pessoais além de nome e e-mail corporativo
  de elaboradores. Use `{{...}}`.

**Tempo verbal por fase.** Artefatos de **planejamento** (concepção, arquitetura) em futuro e
intenção: "o projeto visa…", "será desenvolvida…", "serão utilizados…", "deverá…". Artefatos de
**resultado** (relatórios de ETL e de modelos, manuais, lista de problemas, closeout, repasse) em
passado ou presente: "foi realizado…", "o sistema permite…".

## Documento de concepção (ME01) — modelo: `assets/templates/concepcao.md`

Indicador típico do PT: "Documentos de concepção e arquitetura do projeto". **Tempo: planejamento.**
Prova que o negócio e os requisitos foram entendidos. Modelo de referência no Drive da unidade;
o esqueleto do template foi extraído do documento aceito (rev.01).

Esqueleto fixo:

1. Capa · Índice
2. **1 Histórico**
3. **2 Introdução**, com 2.1 Motivação · 2.2 Objetivos (metas numeradas) · 2.3 Público alvo deste
   documento · 2.4 Referências
4. **3 Projeto** (visão geral do que o projeto visa fazer)
5. **4 Escopo**, uma subseção por fase do PT: 4.1 Planejamento inicial · 4.2 Identificação e
   Configuração dos Dados nos equipamentos · 4.3 Tratamento e Carga dos dados · 4.4 Concepção e
   Desenvolvimento de Sistema Web · 4.5 Desenvolvimento de modelos inteligentes · 4.6 Documentação ·
   4.7 Treinamento e transferência tecnológica
6. **5 Requisitos do Projeto**, com 5.1 Requisitos Funcionais · 5.2 Requisitos Não Funcionais ·
   Definições (glossário)
7. **6 Cronograma**: tabela do PT copiada sem alterar a redação (Macroentrega · Etapa/Atividade ·
   Responsável · Mês de início · Mês de término · Indicador físico), mais as macroentregas descritas em
   uma linha cada

Fonte: PT seções 1 a 4 e 8 e a proposta comercial; é uma reorganização do PT com o entendimento do
processo da empresa, com pouca invenção. Se o PT vigente tem outra quantidade de MEs ou outra
redação de indicador do que o documento de referência, vale o PT vigente (pergunta em aberto 3 do
`SKILL.md`).

## Documento de arquitetura (ME01) — esqueleto inferido, confirmar contra o modelo do Drive

**Tempo: planejamento** (a arquitetura "será implementada"; descreva o existente no presente).
Orienta quem vai instalar, integrar, manter e replicar a solução.
Seções: Introdução · Motivação · Arquitetura geral (como é hoje e como ficará; fontes de dados) ·
Software (componentes: banco de dados, plataforma, aplicação web, linguagem de dados; módulos
auxiliares como ETL, modelos inteligentes e notificações; figura da arquitetura) · Funcionalidades
da aplicação web (uma subseção por tela) · Diagrama e dicionário do banco de dados (uma subseção
por tabela) · Mecanismos inteligentes (engenharia de dados, análise exploratória e modelo,
operação e implantação).
Fonte: ADRs, repositório, diagramas do time. Atribua decisões a ADRs quando existirem. Este é o
documento técnico: é aqui (e não no Relatório) que cabem nomes de tabelas e de componentes.

## Relatório do projeto de ETL / Relatório do modelo — esqueleto inferido

**Tempo: resultado (presente/passado).** Formato de README técnico. ETL: visão geral, estrutura de
pastas e módulos (o que cada um faz), configuração e instalação (comandos reproduzíveis). Modelo:
visão geral, funcionamento passo a passo, fundamento estatístico, parâmetros configuráveis,
vantagens.

## Relatório de análise de modelos (IA) — esqueleto inferido

**Tempo: resultado (passado).** Compara abordagens avaliadas e justifica a escolhida.
Seções: Análises estatísticas (histórica) · Análises em tempo real · Detecção preditiva. Para cada
modelo: vantagens, riscos, funcionamento, comentários, e quando houver experimento, otimização
de parâmetros e resultado. Termina com **limitações e recomendações** (ex.: variáveis adicionais
necessárias). É o lugar técnico onde nasce o detalhe que, no Relatório de Execução Física, vira só
uma frase de prazo e impacto em "Divergências".
Fonte: notebooks, relatórios de experimento e resultados reais. Não invente métricas.

## Protótipos e resultados de sprints

Apresentações do time (baixa e alta fidelidade; resultados por sprint). A skill não as redige;
resume o conteúdo no Termo e cita o arquivo como indicador.

## Manual de deploy — esqueleto inferido

**Tempo: resultado (presente, passos no imperativo).** Público: TI/DevOps do cliente. Seções:
Introdução · Objetivo · Público-alvo · Deploy (passo a passo numerado e na ordem de execução, versão
do sistema operacional, comandos, retorno esperado).
Cuide de segredos: use `{{SENHA}}`, `{{IP_DO_SERVIDOR}}` e peça que o cliente defina os valores;
o manual real trazia hash de senha e IP interno e isso deve ser evitado.

## Manual do usuário — esqueleto inferido

**Tempo: resultado (presente).** Público: cada perfil de usuário (ex.: administrador, operador),
descritos na seção de público-alvo. Seções: Introdução · Objetivo · Público-alvo · Acesso · Login e
perfis · uma seção por funcionalidade com passos (criar, editar, excluir, configurar) · Gráficos ·
Relatórios · Configurações de notificação · FAQ · Controle de versão. Passos curtos e numerados, com
os nomes de tela e botão como aparecem na aplicação (confira no sistema rodando, não só no código).

## Lista de problemas com status das correções

**Tempo: resultado (passado).** Exportada do Jira (bugs/não conformidades do ciclo de testes).
Colunas: ID · descrição · severidade · status · sprint da correção · revalidação. Introduza com 2 ou 3
frases sobre o plano de testes (funcionais, exploratórios, regressão, E2E). Nunca omita problemas
abertos. É aqui que contagens de testes podem aparecer, não no Relatório.

## Closeout (apresentação de encerramento)

Agenda do projeto de referência: visão geral da unidade · visão geral do projeto · roadmap ·
entregas EMBRAPII (por macroentrega) · o produto · objetivos e resultados · indicadores do projeto
· lições aprendidas · oportunidades e novos projetos · stakeholders e equipe · ações e próximos
passos. Indicadores só com dados fornecidos (NPS, selo de qualidade, % de aceite) e com data e
origem. Lições aprendidas e oportunidades: perguntar ao gerente do projeto, não deduzir.

## Registro do repasse tecnológico

Parte do Termo da última ME. Registre o que foi transferido (documentação técnica, manuais de
operação e implantação, código-fonte), a quem e quando, e como o cliente passou a ter autonomia.
Não prometa suporte contínuo após o encerramento.
