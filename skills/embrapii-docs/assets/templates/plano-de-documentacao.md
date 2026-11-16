# Mapeamento de documentação — {{TITULO_DO_PROJETO}} ({{CODIGO_PROJETO}})

<!--
ETAPA INTERNA. Este arquivo NÃO é o que se entrega. Ele liga cada indicador físico do PT ao
artefato que o comprova, ao modelo que esse artefato segue e às fontes a usar. A entrega são os
próprios artefatos (o Documento de Concepção, o Relatório de ETL, o manual...) mais Termo e Relatório.
NÃO acrescente coluna de status nem lista de "o que falta escrever": isso é acompanhamento, e o
acompanhamento não comprova nada para a EMBRAPII.
-->

Fonte: Plano de Trabalho {{NN}}, versão {{VERSAO_OU_DATA}} (cronograma na seção 8; conferir a imagem da página).
Vigência: {{INICIO}} a {{FIM}}.

## Indicador físico → artefato que o comprova

| ME | TRL final | Atividade (texto do PT) | Início | Término | Indicador físico (PT) | Artefato a gerar (nome do arquivo) | Modelo | Fontes |
|---|---|---|---|---|---|---|---|---|
| ME01 | {{TRL}} | {{ATIVIDADE}} | Mês {{N}} | Mês {{N}} | {{INDICADOR_DO_PT}} | `1. Documento de Concepção` | `assets/templates/concepcao.md` | PT 1–4 e 8, proposta |

<!--
Regras de preenchimento:
- Um indicador do PT = uma linha; indicador que o PT junta com vírgula = linhas separadas, e avise a divisão.
- Se o artefato real difere da redação do PT (ex.: serviço terceirizado), escreva o artefato real e destaque a diferença para o usuário.
- Indicador sem modelo em assets/templates/: use o esqueleto de references/indicadores-fisicos.md.
- Indicador cuja atividade ainda não existe no repositório/Jira: mantenha a linha; a ausência será tratada como divergência de prazo no Relatório, nunca como texto de entrega.
-->

## Documentos formais (gerados quando o gatilho ocorre)

| Documento | Gatilho | Modelo | Reaproveita |
|---|---|---|---|
| Termo de Aceite ME{{NN}} | Todas as atividades da ME concluídas | `assets/templates/termo-de-aceite.md` | Artefatos da ME, ficha do projeto |
| Relatório de Execução Física {{NN}}/{{AAAA}} ({{Parcial/Final}}) | Fechamento do período | `assets/templates/relatorio-execucao-fisica.md` | Termos, Jira, divergências de prazo |
| Avaliação Final (Q2) | Encerramento do projeto | `assets/templates/avaliacao-final-q2.md` | PT 7, Relatório final |

## Divergências de prazo já conhecidas

| Atividade / ME | Previsto | Real ou nova previsão | Impacto |
|---|---|---|---|

## Perguntas em aberto

- {{PENDENCIA}}
