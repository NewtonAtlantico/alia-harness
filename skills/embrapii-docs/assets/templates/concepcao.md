<!--
MODELO: Documento de Concepção (indicador físico "Documentos de concepção e arquitetura do projeto", ME01).
Esqueleto fixo extraído do documento de referência aceito (rev.01). Não crie nem omita seções.
TEMPO VERBAL: planejamento. O projeto "visa…", "será desenvolvida…", "serão utilizados…", "deverá…".
Nunca passado de execução: este documento nasce antes do desenvolvimento.
FONTES: PT seções 1 a 4 e 8 (escopo, requisitos, cronograma), proposta comercial, ficha do projeto.
Poucos fatos novos: é a reorganização do PT com o entendimento do processo da empresa.
-->

{{TITULO_DO_PROJETO}}

DOCUMENTO DE CONCEPÇÃO

Responsável: {{RESPONSAVEL_PELO_DOCUMENTO}}    Classificação: RESERVADO

| Elaborador(es) | E-mail |
|---|---|
| {{NOME}} | {{EMAIL}} |

© {{EMPRESA_EXECUTORA}} – Todos os direitos reservados

<!-- Cabeçalho "logo | Documento de Concepção | N / TOTAL" e rodapé "©…" são aplicados em todas as
     páginas por scripts/build_docx.py; responsável, elaboradores e autor do Histórico vêm da ficha
     (dados da Unidade). -->

ÍNDICE
<!-- Gerado a partir dos títulos abaixo; confira que o índice bate com o corpo do documento. -->

## 1 Histórico

| Data | Versão | Responsável | Alteração |
|---|---|---|---|
| {{DD/MM/AAAA}} | A.01 | {{NOME}} | Criação do documento |

## 2 Introdução

{{PARAGRAFO_1: o problema do cliente hoje (ex.: atividades manuais no controle do processo produtivo) e por que é um desafio tecnológico e estratégico.}}

{{PARAGRAFO_2: "Nesse contexto, o projeto proposto visa …" — o que será aprimorado e com quais dados e mecanismos.}}

{{PARAGRAFO_3: o que "será implementado" para tratar o problema (coleta, registro, relatórios, dashboards).}}

{{PARAGRAFO_4: o conjunto de inovações e o resultado esperado.}}

{{PARAGRAFO_5: como os requisitos funcionais e não funcionais detalham a abordagem e as metas do projeto.}}

### 2.1 Motivação

{{2 a 3 parágrafos: quem é o cliente, o que busca, de onde virão os dados (equipamentos, sistemas), o que a empresa passa a ganhar (menos atividade manual, análise das causas das paradas, produtividade e competitividade). Tempo verbal de intenção.}}

### 2.2 Objetivos

Desenvolver {{DESCRICAO_DA_SOLUCAO}}. Este sistema tem como metas principais:

1. {{META_1 — vinda do PT 2/3}};
2. {{META_2}};
3. {{META_3}}.

{{PARAGRAFO_DE_FECHO: "Ao alcançar esses objetivos, busca-se…"}}

### 2.3 Público alvo deste documento

- {{UNIDADE_EMBRAPII}}
- {{EMPRESA_PARCEIRA}}

### 2.4 Referências

[1] PLANO DE TRABALHO EMBRAPII Nº {{NN}}, vinculado ao Termo de Parceria nº {{NN/AAAA}}, celebrado entre a UNIDADE EMBRAPII {{NOME}} e a empresa parceira {{RAZAO_SOCIAL}}
[2] {{DOCUMENTO_DE_APRESENTACAO_OU_KICKOFF}}
[3] {{DOCUMENTO_DE_ARQUITETURA_DO_PROJETO}}

## 3 Projeto

{{3 a 4 parágrafos: "O projeto visa mapear, coletar e armazenar dados de …"; como os dados serão processados; a aplicação web que "será desenvolvida" para registro das paradas; os modelos estatísticos e de machine learning que "serão utilizados"; remissão ao Documento de Arquitetura.}}

## 4 Escopo

{{PARAGRAFO_DE_ESCOPO: "O escopo deste projeto engloba …"}}

{{PARAGRAFO_DO_OBJETIVO_PRINCIPAL}}

<!-- Uma subseção por fase do PT, nesta ordem e com estes títulos. Cada uma é uma lista curta de itens no infinitivo ou no futuro. -->

### 4.1 Planejamento inicial

- Realizar o planejamento macro das atividades
- Imersão nos processos e características da produção de {{SEGMENTO_DO_CLIENTE}}

### 4.2 Identificação e Configuração dos Dados nos {{EQUIPAMENTOS}}

- Levantamento de dados disponíveis;
- Definição dos dados elegíveis;
- Tagueamento dos dados selecionados;
- Coleta e armazenamento em banco de dados dedicado

### 4.3 Tratamento e Carga dos dados dos {{EQUIPAMENTOS}}

- Implementação de ETLs e rotinas de coletas de dados;
- Realizar tratamento dos dados coletados

### 4.4 Concepção e Desenvolvimento de Sistema Web

- Criação dos protótipos da aplicação web
- Implementação de códigos para a aplicação Web

### 4.5 Desenvolvimento de modelos inteligentes

- Implementação de modelos adequados à volumetria e ao perfil dos dados
- Melhoria dos modelos implementados.

### 4.6 Documentação

- Manuais de operação e manutenção;
- Relatórios de desempenho do projeto.

### 4.7 Treinamento e transferência tecnológica

- Treinamentos para utilização e expansão da aplicação
- Transferência tecnológica

## 5 Requisitos do Projeto

Foram levantados diversos requisitos do sistema, entre requisitos funcionais e não funcionais:

- A solução deverá {{REQUISITO_MACRO_1}};
- {{REQUISITO_MACRO_2}};
- {{REQUISITO_MACRO_3}};
- {{REQUISITO_MACRO_4: ex.: arquivamento por período a ser estipulado}}.

Alguns outros requisitos incluem:

- A documentação completa do sistema;
- Fluxo de retomada do sistema após parada de emergência;
- Conformidade com regulamentações;
- Descrição das funcionalidades.

### 5.1 Requisitos Funcionais

<!-- Um item por requisito do PT/proposta, no formato "Nome: descrição no futuro". -->

- {{NOME_DO_REQUISITO}}: {{DESCRICAO_NO_FUTURO — "deverão ser…", "o sistema deve…"}};

### 5.2 Requisitos Não Funcionais

<!-- Escalabilidade, Desempenho, Segurança, Conformidade, Suporte a dados estruturados/semiestruturados/não estruturados, Facilidade de uso, Manutenção, Recuperação de falhas — manter os que o PT/proposta trazem; incluir os de segurança e conformidade que o projeto confirmou. -->

- {{NOME_DO_REQUISITO}}: {{DESCRICAO}};

Definições:

- {{TERMO}}: {{DEFINICAO_EM_LINGUAGEM_DE_NEGOCIO}}

## 6 Cronograma

O cronograma a seguir consta do Plano de Trabalho e foi definido durante a fase de proposta do projeto e considerando as premissas, restrições e riscos também registrados no Plano de Trabalho.

<!-- Copie a tabela do cronograma do PT sem alterar a redação: Macroentrega · Etapa / Atividade · Responsável pela execução · Mês de Início · Mês de Término · Indicador físico de entrega. Confira contra a imagem da página do PT, a extração de texto embaralha as linhas. -->

| Macroentrega | Etapa / Atividade | Responsável pela execução | Mês de Início | Mês de Término | Indicador físico de entrega |
|---|---|---|---|---|---|
| ME{{NN}} | {{ATIVIDADE_DO_PT}} | {{RESPONSAVEL_DO_PT}} | Mês {{N}} | Mês {{N}} | {{INDICADOR_DO_PT}} |

O cronograma de atividades está dividido em {{N}} macroentregas:

- ME01: {{DESCRICAO_DA_ME_COPIADA_DO_PT}};
- ME02: {{...}};
- ME03: {{...}}.

Cada macroentrega é composta por uma ou mais etapas/atividades, que são executadas pelo {{UNIDADE_EMBRAPII}}, com apoio da {{EMPRESA_PARCEIRA}}.
