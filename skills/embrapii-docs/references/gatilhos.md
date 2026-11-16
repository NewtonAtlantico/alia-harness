# Gatilhos de geração de documentos

Responde à pergunta "terminei X, o que preciso gerar?". A regra de ouro: **a coluna "Indicador
físico de entrega" do cronograma do PT é a tabela de gatilhos.** Terminar uma atividade gera o
indicador físico dela; fechar todas as atividades de uma ME gera o Termo; fechar um período de
prestação de contas gera o Relatório de Execução Física.

## Como ler o PT

O cronograma lista, por linha: macroentrega (e TRL final), etapa/atividade, responsável, mês
de início, mês de término e indicador físico de entrega. Monte o mapeamento interno
(`assets/templates/plano-de-documentacao.md`) com uma linha por indicador: ele liga o indicador ao
**artefato que o comprova**, ao modelo e às fontes. Não é acompanhamento de status e não é a entrega.

Duas armadilhas vistas no projeto de referência:

- **A numeração de ME pode mudar na execução.** O PT trazia 4 MEs (ME01–ME04, TRL 3 a 6, blocos
  de 2 meses), mas foram aceitas 3: as atividades da ME04 foram incorporadas ao Termo da ME03.
  A cadência real foi de cerca de 3 meses (aceites em fev, jun e set), não os 2 meses do PT.
  Siga o que o PT vigente e os Termos já aceitos dizem; não assuma 3 MEs nem 3 meses.
- **O indicador entregue pode diferir da redação do PT.** O PT dizia "Controladores lógicos
  programados"; o Termo aceito cita "Relatórios de execução de serviços de terceiros", porque o
  cabeamento e o tagueamento foram contratados fora. Parta da redação do PT, confira o que
  existe na pasta e, se diferir, cite o artefato real e avise o usuário.

## Mapa de gatilhos (com o projeto de referência)

A coluna "Documento a escrever" é o **artefato que a skill entrega** para aquele indicador, no
esqueleto de `indicadores-fisicos.md` (ou no modelo próprio, como a concepção).

| Atividade concluída (redação do PT) | Indicador físico entregue | Documento a escrever |
|---|---|---|
| Concepção do projeto, levantamento de requisitos, mapeamento de processos | Documento de concepção | Concepção (`indicadores-fisicos.md`) |
| Programação dos controladores e identificação dos dados | Relatórios de execução de serviços de terceiros | Fornecido pelo prestador; a skill só o referencia |
| Criação da arquitetura de software e início do desenvolvimento | Documento de arquitetura | Arquitetura |
| Mapeamento dos dados e criação da estrutura de dados | Arquivo .sql com dump do banco | Artefato técnico; a skill só o referencia |
| Início da criação e configuração das ETLs | Relatório do projeto de ETL | Relatório de ETL |
| Features principais e integração com hardware | Protótipos de baixa e alta fidelidade + resultados de sprints | Apresentações do time de UX/dev; a skill resume no Termo |
| Criação inicial dos modelos de machine learning | Relatório do modelo escolhido | Relatório do modelo |
| Melhoria dos modelos, dashboards e relatórios | Relatório de análise de modelos de IA | Relatório de análise de modelos |
| Conclusão da aplicação web e início dos testes integrados | Manual de deploy + aplicação instalada em servidor | Manual de deploy |
| Testes de integração e ajustes | Lista de problemas com status das correções | Lista de problemas (export do Jira) |
| Documentação final | Manual do projeto / do usuário | Manual do usuário |
| Repasse tecnológico | Repasse realizado + manual de deploy | Registro do repasse |
| Processo de encerramento | Apresentação de closeout | Closeout |

## O que cada evento dispara

**Fim de sprint / sprint review.** Não gera documento oficial. É o momento de registrar evidências
(issues concluídas, demonstrações, decisões do cliente, atrasos) que serão a matéria-prima de
Termo e Relatório três meses depois. Se o time exporta o Jira a cada fechamento de sprint, o texto
final fica muito mais fácil e o risco de esquecer um desvio cai.

**Terminou o desenvolvimento da aplicação web.** Dispara os indicadores físicos ligados a essa
atividade (manual de deploy; aplicação instalada em homologação) e o início da atividade de testes
integrados. **Não** dispara Termo nem Anexo 10: esses dependem de fechar a ME inteira e o período.

**Fechou a ME (todas as atividades com indicador pronto).** Gera o Termo de Aceite da ME,
reúne o pacote de indicadores na pasta da ME e dispara a assinatura. A data do Termo é a do
aceite.

**Fechou o período de prestação de contas.** Gera o Relatório de Execução Física. Ele reúne as
MEs do período: as aceitas com a data de aceite, a que está em curso como "Em andamento". Quando
uma ME atravessa dois relatórios, o segundo diz que parte das atividades foi descrita no relatório
anterior e cobre só o restante.

**Desvio detectado (atraso, escopo alterado, resultado abaixo do esperado).** Registre na hora, com
causa e validação do cliente (e-mail, ata). Entra em "Divergências em relação ao planejado" no
próximo Relatório.

**Encerramento do projeto.** Último Termo, Relatório final, closeout, repasse tecnológico e
Avaliação Final (Q2). O momento exato do Q2 é pergunta em aberto (ver SKILL.md).

## Pacote de uma macroentrega

Pasta `MEnn/` contendo: Termo de Aceite (editável e `MEnn assinado.pdf`) e os indicadores físicos
numerados pela ordem das atividades no Termo (`1. ...`, `2&6. ...` quando um documento atende a
duas atividades). Antes de fechar o Termo, confira que cada "Indicador físico" citado tem arquivo.
