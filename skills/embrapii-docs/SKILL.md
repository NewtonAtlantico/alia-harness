---
name: embrapii-docs
description: Escreve a documentação exigida em projetos EMBRAPII — os próprios artefatos que comprovam cada indicador físico do Plano de Trabalho (documento de concepção, arquitetura, relatórios de ETL e de modelos de IA, manual do usuário, manual de deploy, lista de problemas, closeout), além do Termo de Aceite de Macroentrega, do Relatório de Execução Física (Anexo 10) e da Avaliação Final Q2. Decide QUAIS documentos gerar e QUANDO a partir do cronograma do PT. Use sempre que o usuário citar EMBRAPII, macroentrega, ME01/ME02/ME03, Plano de Trabalho ou PT, anexo 10, execução física, termo de aceite, indicador físico, documento de concepção, prestação de contas, repasse tecnológico, closeout, avaliação final, ou disser que terminou uma entrega, etapa ou sprint de um projeto de P&D e precisa da documentação, mesmo sem dizer o nome do documento.
---

# Documentação de projetos EMBRAPII

Em um projeto EMBRAPII a documentação é uma cadeia de prestação de contas, não um conjunto
de papéis soltos. O **Plano de Trabalho (PT)** assinado com a empresa parceira define as
macroentregas (ME), as atividades de cada uma e o **indicador físico**: a comprovação material,
tangível ou documental de que a atividade foi concluída. Tudo o que esta skill escreve parte
desse cronograma:

```
PT (cronograma: ME → atividade → indicador físico)
 ├─ atividade concluída ........ o ARTEFATO do indicador físico (o documento em si)
 ├─ ME concluída ............... Termo de Aceite da ME (+ pacote com os indicadores)
 ├─ período de prestação ....... Relatório de Execução Física (Anexo 10), parcial ou final
 └─ projeto encerrado .......... Relatório final, closeout, repasse, Avaliação Final (Q2)
```

**A entrega desta skill são os artefatos, não um acompanhamento deles.** Se o indicador é
"Documentos de concepção e arquitetura do projeto", a saída é o Documento de Concepção
completo, com capa, histórico, introdução, projeto, escopo, requisitos e cronograma. Uma tabela
com "status" e "o que falta escrever" não comprova nada e não é um produto desta skill.

Fluxo de trabalho, sempre nesta ordem:

1. **Mapear** (etapa interna): ligar cada indicador físico do PT ao artefato que o comprova.
2. **Modelo**: cada artefato tem um esqueleto fixo de seções e o tempo verbal da fase em que é
   escrito.
3. **Gerar**: redigir cada artefato no seu modelo. A entrega final são esses documentos.

Os leitores são o coordenador da empresa parceira (que assinou o contrato) e a EMBRAPII.
Eles avaliam se o que foi prometido no PT foi entregue, então o texto precisa de linguagem de
negócio, fatos verificáveis e a mesma terminologia do PT.

## Passo 1 — Mapear: o que gerar

O usuário pode chegar de três jeitos; descubra qual antes de escrever qualquer coisa.

- **Pediu um documento pelo nome** (ex.: "faz o Documento de Concepção", "faz o Termo da ME02"):
  vá ao Passo 2, mas confirme que a ME/atividade existe no PT.
- **Descreveu um evento** (ex.: "terminamos a aplicação web", "fechamos a sprint 12"): consulte a
  tabela de gatilhos abaixo e diga ao usuário o que esse evento dispara e o que ainda **não**
  dispara. Terminar o desenvolvimento não gera o Anexo 10 por si só; gera o artefato do indicador
  físico daquela atividade, e o Anexo 10 só entra quando a ME ou o período fecha.
- **Perguntou "o que preciso gerar?"**: monte o **plano de documentação**, agora um mapeamento interno
  (`assets/templates/plano-de-documentacao.md`) lendo o cronograma do PT, e responda com a lista de
  artefatos, não com uma tabela de andamento.

O plano de documentação continua existindo, mas só como etapa interna: uma linha por indicador físico (ME · atividade · indicador do PT · artefato
que o comprova · modelo a usar · fontes). Ele diz **o que escrever e de onde tirar**; não carrega
coluna de status. Só o mostre ao usuário se ele pedir ou para confirmar a divisão de atividades.

| Gatilho | O que gerar | Detalhes |
|---|---|---|
| Kickoff / PT assinado | Mapeamento (interno) e, em seguida, os artefatos da ME01 (concepção, arquitetura) | `references/gatilhos.md` |
| Atividade de uma ME concluída | O **artefato** do indicador físico daquela atividade | `references/indicadores-fisicos.md` |
| Sprint review (contínuo) | Nada formal; registrar evidências, datas e desvios para uso posterior | `references/gatilhos.md` |
| Todas as atividades da ME concluídas (mês de término no PT) | **Termo de Aceite** da ME + pacote de indicadores | `references/termo-e-relatorio.md` |
| Fechamento de período de prestação de contas | **Relatório de Execução Física** (parcial; ME em curso = "Em andamento") | `references/termo-e-relatorio.md` |
| Atraso, mudança de escopo ou resultado abaixo do esperado | Entrada em "Divergências em relação ao planejado" | `references/termo-e-relatorio.md` |
| Última ME aceita / encerramento | Relatório final, closeout, repasse tecnológico, **Avaliação Final (Q2)** | `references/avaliacao-final-q2.md` |

Prioridade combinada com o time: se o cronograma estiver apertado, entregue primeiro Termo de
Aceite e Relatório de Execução Física, que são padronizados. Os artefatos de indicador físico vêm em
seguida, porque variam por projeto, mas **quando o usuário pede um indicador, a entrega é o
artefato completo**.

## Passo 2 — Reunir as fontes

Sem fonte, o documento vira texto plausível e errado. Reúna antes de escrever:

1. **PT do projeto** (obrigatório). Leia o cronograma (seção "Cronograma de trabalho") para
   obter ME, atividades, meses e indicador físico, e a seção de objetivos técnicos e
   resultados (usada na Avaliação Final). Extraia o PDF com
   `pdftotext -enc UTF-8 -layout <pt.pdf> -`. A tabela do cronograma sai embaralhada na extração:
   renderize a página como imagem (ex.: `pymupdf`) e confira ME e atividades visualmente, e com o
   usuário se houver dúvida.
2. **Ficha do projeto.** Antes de escrever qualquer cabeçalho, capa ou assinatura, preencha
   a ficha (`assets/templates/ficha-do-projeto.md`; guarde a do projeto fora do pacote, ex.:
   `embrapii/_ficha-do-projeto.md`) em três camadas, nesta ordem:
   - **PT e proposta:** título, razão social, CNPJ, Unidade EMBRAPII, nº do Termo de Parceria,
     prazo, TRL por ME, endereço da Unidade, cronograma.
   - **Documentos aceitos de referência** (o Relatório de Execução Física aceito e o Documento de
     Concepção aceito, que o usuário aponta como modelo): signatário da Unidade, contador, CRC,
     versão do modelo, responsável e elaboradores. Esses dados são da **Unidade**, valem para todo
     documento e período, e **não estão no PT**; por isso o PT "não ter" esses nomes nunca é motivo
     para sair com `{{placeholder}}`. Procure primeiro nos modelos e nos anexos que o usuário deu.
   - **Só a pessoa tem:** código do projeto, coordenador e CPF dele, datas de vigência, período de
     referência, datas de emissão e aceite. Pergunte **uma vez**, grave na ficha e reaproveite.
   Cabeçalho, capa e assinaturas saem preenchidos; só vira `{{PLACEHOLDER}}` o que nenhuma das três
   camadas forneceu. Nunca invente. (Validação de 04/11/2026: cabeçalho, capa e assinaturas com
   placeholders foram reprovados quando havia fonte.)
3. **Termos e Relatórios anteriores do mesmo projeto**, se existirem. Mantenha títulos de ME,
   nomes de indicadores, signatário e estilo idênticos aos anteriores; o avaliador compara um com
   o outro.
4. **Evidências do período**: export do Jira (issues resolvidas, sprint reviews, bugs), relatórios
   de testes, relatórios de modelos, atas, e-mails de validação, reuniões e visitas técnicas. Se
   houver acesso ao Jira por MCP, consulte direto; senão peça o export.
   **Quando o repositório do projeto é o produto entregue**, preencha os modelos com o que as
   tarefas concluídas e o código sustentam, sem esperar que o usuário descreva a entrega:
   - status das tarefas: Jira (MCP) se acessível; senão `git log` (chaves `PROJ-nnn` nos commits),
     notas de implementação e specs do repositório;
   - o que existe de fato: estrutura de `src/`, `README.md` (incluindo limitações conhecidas), ADRs,
     specs, testes. Rode as suítes de teste para **confirmar** o estado, mas não leve contagens de
     testes, nomes de tabelas ou de componentes para Termo ou Relatório (ver "Estilo" abaixo); isso
     fica nos documentos técnicos (arquitetura, lista de problemas);
   - o que **não** existe tem o mesmo peso: atividade do PT sem código ou artefato correspondente
     (ex.: modelos de ML, integração com hardware real, manuais) vira divergência de prazo, nunca
     parágrafo de entrega. Fonte simulada, mock ou verificação feita só em ambiente de
     desenvolvimento deve ser dita como tal, em linguagem de negócio.
5. **Dados que só a pessoa tem**: datas de aceite e de emissão, assinantes, código do projeto,
   contador e CRC. Os PDFs do PT costumam vir sem esses nomes; confirme na fonte e, não achando,
   peça ou deixe `{{PLACEHOLDER}}`.

Escreva só o que as fontes sustentam. Se o Jira não mostra uma entrega que o PT promete, isso é
uma pergunta para o usuário e provavelmente uma divergência a registrar, não um parágrafo a
preencher.

## Passo 3 — Escrever

Leia a referência do documento pedido e parta do modelo em `assets/templates/`:

| Documento | Modelo | Regras e exemplos |
|---|---|---|
| Documento de concepção | `assets/templates/concepcao.md` | `references/indicadores-fisicos.md` |
| Termo de Aceite de Macroentrega | `assets/templates/termo-de-aceite.md` | `references/termo-e-relatorio.md` |
| Relatório de Execução Física (Anexo 10) | `assets/templates/relatorio-execucao-fisica.md` | `references/termo-e-relatorio.md` |
| Avaliação Final (Q2) | `assets/templates/avaliacao-final-q2.md` | `references/avaliacao-final-q2.md` |
| Arquitetura, relatórios de ETL e de modelos, manuais, lista de problemas, closeout | esqueleto fixo em `references/indicadores-fisicos.md` | idem |

Regras gerais de escrita (cada uma existe por um motivo que o avaliador sente):

- **Esqueleto fixo e tempo verbal da fase.** Cada artefato segue o esqueleto do seu modelo, sem
  seções inventadas nem omitidas. O tempo verbal é o da fase em que o documento nasce:
  planejamento (concepção, arquitetura) em futuro/intenção ("o projeto visa…", "será
  desenvolvida…"); resultado (Termo, Relatório, relatórios de ETL e de modelos, manuais, closeout)
  em passado ou presente ("Essa entrega consistiu em…").
- **Estilo institucional, de relato de gestão.** Quem avalia é um gestor da empresa parceira, não
  um engenheiro. Escreva sobre o **projeto** (reuniões, visitas técnicas, colaboração com a TI do
  cliente, metodologia, validações), não sobre o **sistema** (contagens de testes, nomes de tabelas
  e de componentes, ADRs). Quando um termo técnico for inevitável, explique na primeira vez, como
  nos documentos aceitos: "ETL (Extração, Transformação e Carga)". Prefira "o sistema passou a
  registrar o motivo de cada parada" a "foi implementado o endpoint de justificativa".
- **Use os nomes do PT.** Títulos de ME e de atividade são copiados literalmente do PT; o
  vínculo entre texto e cronograma é o que o avaliador confere. Se o indicador realmente
  entregue difere da redação do PT, cite o artefato real e deixe a diferença visível ao usuário.
- **Honestidade sobre divergências.** Os documentos aceitos registram sem rodeio que uma ME atrasou,
  com data prevista, data real e impacto. Isso protege o projeto; suavizar ou omitir é o risco
  real. Não invente métricas nem indicadores (NPS, selos, percentuais) que o usuário não forneceu.
- **Maturidade tecnológica (TRL 3–6).** O PT declara que resultados EMBRAPII não têm maturidade para
  implantação ou comercialização fora do projeto. Não escreva "pronto para produção" ou "solução
  comercial"; use "validado em ambiente de homologação / piloto".
- **Limites de tamanho.** O texto de cada ME no Relatório tem teto de 5.000 caracteres; campos do
  questionário Q2 têm 150. Mire em 3.500–4.800 no Relatório (os aceitos têm 3.200–4.300). Confira
  com o script do Passo 4, nunca "no olho".
- **A entrega tem o layout do modelo, em `.docx`.** O Markdown é só a fonte de trabalho (e o que o
  `check_doc.py` mede). O que vai para a equipe e para o cliente é o `.docx` gerado por
  `scripts/build_docx.py`: logo no cabeçalho, rodapé institucional, paginação "N de TOTAL", capa,
  índice e tabelas formatadas como nos modelos aceitos. Use `.docx` e não `.doc`: o Google Docs
  importa `.docx` sem perder formatação, e o `.doc` binário antigo só existe se alguém exigir
  (`word_finalize.ps1 -SalvarDoc`). O Relatório usa uma tabela HTML simples no Markdown só para que a
  narrativa fique **dentro da célula**, como no modelo.

## Passo 4 — Verificar

Rode o verificador sobre os arquivos gerados em Markdown:

```bash
python -I .claude/skills/embrapii-docs/scripts/check_doc.py caminho/do/arquivo.md
```

Ele mede os blocos marcados com `<!-- limite: N -->` (caracteres com espaços, como o Word),
lista `{{PLACEHOLDERS}}` não resolvidos e avisa sobre CPF/e-mail soltos, frases que contrariam o
enquadramento TRL e desvios de estilo do Relatório (subtítulos em negrito na narrativa, subseção de
pendências, "validação ainda será registrada", contagens de testes, jargão de engenharia). Falha
(código 1) se algum bloco passar do limite. Depois confira:

- [ ] Todo título de ME e de atividade bate com o PT, palavra por palavra, e o título da ME lista
      **todas** as atividades previstas no PT para ela, inclusive as ainda não executadas.
- [ ] Todo "Indicador físico" citado existe como arquivo no pacote da ME.
- [ ] Datas coerentes: aceite da ME dentro da vigência; emissão do Relatório depois do aceite.
- [ ] O que está "Em andamento" não aparece como concluído; o que foi descrito num relatório
      anterior não é repetido, só referenciado.
- [ ] Nada do PT foi prometido e silenciosamente omitido (virou entrega ou divergência de prazo).
- [ ] Artefato de indicador: tem todas as seções do esqueleto e o tempo verbal da fase.
- [ ] Cabeçalho, capa e assinaturas **sem** `{{placeholder}}` que a ficha, o PT ou os modelos de
      referência já resolvem. Sobraram só os campos que apenas a pessoa tem.

## Passo 5 — Entregar

Gere o `.docx` de cada documento a partir do Markdown já verificado:

```bash
pip install python-docx        # uma vez
python -I .claude/skills/embrapii-docs/scripts/build_docx.py "embrapii/ME01/1. Documento de Concepção.md" "embrapii/ME01/1. Documento de Concepção.docx" --tipo concepcao
python -I .claude/skills/embrapii-docs/scripts/build_docx.py embrapii/relatorio-execucao-fisica-parcial.md embrapii/relatorio-execucao-fisica-parcial.docx --tipo relatorio
```

`--tipo generico` serve ao Termo de Aceite e aos demais artefatos (logo, título e © nas páginas). O
script avisa os `{{placeholders}}` que sobraram, destacados em amarelo no documento. Com o Word
instalado, rode `scripts/word_finalize.ps1 -Docx <arquivo.docx>`: atualiza o índice com os números de
página, regrava e exporta um PDF; **olhe o PDF** (capa, índice, tabela da ME, assinaturas e rodapé)
antes de entregar. Sem o Word, o índice sai com os títulos e sem nº de página, e o Google Docs
permite regerá-lo com um clique (Inserir → Índice).

Entregue os **artefatos**, um arquivo por documento, em uma pasta por macroentrega (ex.:
`embrapii/ME01/`) ou onde o usuário indicar. O plano/mapeamento, se salvo, fica fora do pacote
(ex.: `embrapii/_mapeamento.md`). Para o pacote, nomeie os indicadores `<n>. <Documento>`, onde n é
a ordem da atividade no Termo, e use `n&m` quando um documento atende a duas atividades (padrão
visto na ME03). O Termo assinado entra como `MEnn assinado.pdf`.

Termine a resposta com:
- a lista curta do que **só uma pessoa pode preencher** (assinantes, datas, código do projeto,
  contador, escolhas do Q2 que dependem da coordenação);
- as suposições que você fez onde as fontes eram ambíguas;
- um lembrete de confidencialidade quando houver dados da empresa parceira (abaixo).

## Confidencialidade

A ferramenta de IA oficialmente liberada nos projetos EMBRAPII da unidade é o Gemini; na prática
equipes usam outras, anonimizando o conteúdo. Os modelos e exemplos desta skill já estão
anonimizados. Ao trabalhar com material de cliente, prefira trabalhar com nomes trocados por
marcadores (`{{EMPRESA}}`, `{{SISTEMA_DE_GESTAO}}`) e restaure no fim. Nunca copie para
documentos credenciais, hashes de senha, IPs internos ou CPF de pessoas; o manual de deploy de
um projeto real chegou a trazer hash de senha e IP interno no texto, e isso não deve se repetir.

## Perguntas em aberto

Não decida sozinho; pergunte ao usuário ou registre como pendência:

1. O teto de 5.000 caracteres vale só para o texto de cada ME no Relatório (premissa desta skill) ou
   também para o Termo? O Termo foi tratado como resumo de uma página.
2. Quando e por quem a Avaliação Final (Q2) é preenchida? A equipe de projeto não tinha certeza;
   consulte um gerente de portfólio que atue com EMBRAPII.
3. Quando o PT lista mais MEs do que as executadas (o projeto de referência tem 4 no PT e 3 nos
   termos aceitos, com a ME04 incorporada à ME03), qual versão do PT vale? Isso define quais
   atividades entram no título de cada ME.
4. Qual o calendário de prestação de contas (os relatórios de referência são 01/2025 e 02/2025)?
5. Quais indicadores físicos adicionais o gerente do projeto considera necessários além dos do PT?
6. Onde ficam os modelos oficiais (Drive) de cada artefato além do Documento de Concepção
   (arquitetura, relatórios, manuais)? Os esqueletos em `references/indicadores-fisicos.md` foram
   inferidos do projeto de referência e devem ser conferidos contra eles.
7. O signatário da Unidade EMBRAPII, o contador e a versão do modelo do Relatório ("Versão_A.1 -
   Out/2023") são fixos entre projetos ou mudam por projeto/período? (A skill os trata como dados da
   Unidade e reaproveita; confirme se algo mudar.)
8. O layout do Relatório (logo no cabeçalho, rodapé, disposição das assinaturas) foi reproduzido a
   partir do modelo de Concepção e do rodapé descrito no Relatório aceito, porque o Word oficial do
   Anexo 10 não está no repositório. Se a unidade tiver esse arquivo, use-o como base do layout.
9. O formato pedido foi "`.doc`". A skill gera `.docx` (compatível com Google Docs e Word) e só grava
   `.doc` com `-SalvarDoc`. Confirme com a equipe se `.docx` atende.
