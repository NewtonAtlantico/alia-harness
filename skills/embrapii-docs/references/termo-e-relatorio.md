# Termo de Aceite de Macroentrega e Relatório de Execução Física (Anexo 10)

Os dois documentos formais, padronizados e recorrentes. Resolvem a maior parte da carga de
documentação. Os exemplos abaixo foram adaptados e anonimizados a partir de documentos aceitos.

## 1. Termo de Aceite de Macroentrega

**Uma por ME. Resumo curto (uma página, até duas em MEs com muitas atividades).** É a prova de que
a empresa parceira aceitou o que foi entregue.

Estrutura fixa:

1. Título: `TERMO DE ACEITE DE MACROENTREGA`
2. Tabela de identificação: Unidade EMBRAPII · Empresa (CNPJ - razão social) · Código do projeto ·
   Número da macroentrega (`ME 01`) · Título da macroentrega
3. `MACROENTREGA: ME01`
4. Frase fixa: "A seguir um breve resumo das entregas previstas e realizadas para esta etapa:"
5. Um bloco por atividade da ME, na ordem do PT:
   - título da atividade, copiado do PT
   - 1 a 3 frases iniciando por "Essa entrega consistiu em..." (a ME03 usa até 5 frases quando a
     atividade teve mais conteúdo)
   - `Indicador físico: <nome do documento ou artefato entregue>`
6. Declaração: "Declaro que a Macroentrega descrita está aceita."
7. Assinante (nome e cargo) e local/data: "Fortaleza, 05 de setembro de 2025"

**Atividade do PT que agrupa entregas distintas.** O PT às vezes junta, numa só linha separada por
vírgula, entregas diferentes (ex.: "criação das features principais e integração com hardware,
criação inicial dos modelos de machine learning"). O Termo aceito separa em um bloco por entrega,
cada um com o seu indicador físico. Faça o mesmo e avise o usuário da divisão.

**Título da ME:** é a lista das atividades da ME separada por `;` ou ` / `, na redação do PT.
Liste **todas** as atividades que o PT prevê para a ME, executadas ou não. Em uma ME que absorveu
outra, o título lista as atividades das duas (ME03 do projeto de referência).

**Como escrever cada bloco.** Diga o que foi feito e por que importa ao negócio, em uma ou duas
frases, e nomeie a evidência no `Indicador físico`. O indicador cita o artefato real, com o nome do
arquivo ou documento como está no pacote.

Exemplo (adaptado):

> **Início da criação e configuração das ETLs**
> Essa entrega consistiu na criação do projeto que implementa um sistema de ETL e de detecção de
> anomalias baseado em média móvel, projetado para analisar dados em tempo real e identificar
> desvios em relação a uma janela de dados históricos. O sistema inclui módulos para simulação,
> visualização e um serviço de insights para integração com dados reais.
> Indicador físico: Relatório do Projeto de ETL e Detecção de Anomalias.

Exemplo de bloco mais rico (adaptado, atividade de maior conteúdo):

> **Testes de integração e ajustes no sistema**
> Essa atividade consistiu na realização massiva de testes para identificação de problemas e
> oportunidades de melhoria na aplicação web. Conforme o plano de testes, foram realizados testes
> funcionais e exploratórios para minimizar riscos e garantir o correto funcionamento. As não
> conformidades foram registradas no sistema de monitoramento do projeto para correção e
> revalidação no decorrer das sprints.
> Indicador físico: Lista de problemas identificados com status das correções.

**Cuidados.** Não descreva como entregue o que não tem indicador. Não use "pronto para produção".
Assinante e data são campos humanos: preencha da ficha do projeto quando já constarem lá; senão
deixe `{{...}}`.

## 2. Relatório de Execução Física (Anexo 10)

**Um por período de prestação de contas (parcial ou final).** É o documento formal da EMBRAPII que
reúne o que foi executado e deve estar casado com as macroentregas e os indicadores do PT. É mais
longo e detalhado que o Termo.

O modelo aceito é um **relato de gestão institucional**. A versão anterior desta skill saiu com
estilo de engenharia e formato próprio, e foi devolvida com a lista de ajustes incorporada abaixo.
Em caso de dúvida, imite o documento aceito, não a organização "mais clara" que parece melhor.

### Estrutura fixa

1. Cabeçalho e capa: `RELATÓRIO DE EXECUÇÃO FÍSICA DO PROJETO` · Unidade EMBRAPII · código do
   projeto e período (`PIAT-XXXX.XXXX | 02/2025`)
2. Dados: projeto (código – título) · responsável/coordenador · período de vigência do projeto ·
   período de referência · tipo (`Prestação de Contas Parcial` ou `Final`) · contador e CRC
3. Tabela: coordenador do projeto · empresas contratantes (CNPJ - razão social)
4. **Uma tabela por ME** do período (ver "Formato da tabela da ME")
5. `DIVERGÊNCIAS EM RELAÇÃO AO PLANEJADO`
6. `Emitido em DD de mês de AAAA` e duas assinaturas: o signatário da Unidade EMBRAPII (nome, com
   "Unidade EMBRAPII" abaixo, sem cargo) e o contador (nome, com `CRC: nnnnn/O-n UF` abaixo)
7. Rodapé institucional: endereço do Instituto Atlântico / Unidade EMBRAPII, paginação e a versão do
   modelo (`Versão_A.1 - Out/2023` no documento aceito; confirme que continua vigente antes de
   usar). No `.docx` gerado por `scripts/build_docx.py` o rodapé já sai aplicado em todas as páginas,
   com o logo no cabeçalho.

### Cabeçalho, capa e assinatura: preencha, não deixe tudo em branco

O documento aceito traz **todos** os campos preenchidos, inclusive nome do signatário, do contador
e CRC. A validação de 04/11/2026 devolveu o Relatório justamente porque cabeçalho, capa e assinaturas
ainda saíam com `{{placeholders}}` mesmo havendo fonte para eles. Siga assim:

- Do PT/proposta, preencha sempre: título do projeto, razão social, CNPJ, Unidade EMBRAPII, prazo,
  nº do Termo de Parceria, endereço da Unidade (rodapé).
- Da **ficha do projeto** (`assets/templates/ficha-do-projeto.md`), preencha: código do projeto,
  coordenador, vigência com datas, signatário, contador e CRC. O PT **não** traz esses dados (nem
  assinaturas), mas eles existem em outras fontes: o Relatório aceito de referência (signatário,
  contador, CRC e versão do modelo) e o Documento de Concepção de referência (responsável e
  elaboradores). A ficha registra de onde cada valor veio; se o valor está na ficha, ele entra no
  documento. Só pergunte ao usuário o que nenhuma fonte tem.
- Signatário, contador, CRC, endereço e versão do modelo são **dados da Unidade**: valem para os
  documentos de qualquer ME e período até alguém dizer o contrário. Não os trate como dado novo a
  cada geração.
- Só fica `{{PLACEHOLDER}}` o que ninguém forneceu. Liste-os no fim da resposta.
- CPF: não repita em texto livre; mantenha `{{CPF_PREENCHER_NO_DOCUMENTO_OFICIAL}}`.

### Formato da tabela da ME

O título da ME e a narrativa ficam **dentro da tabela**, como no modelo, e não em texto solto:

- Primeira linha: `MACROENTREGA: MEnn` seguida das atividades como **lista de marcadores**, cada
  uma terminando em `;` e a última em `.`. Não use o prefixo `/` entre atividades.
- Liste **todas** as atividades que o PT prevê para a ME, também as não executadas ou parciais
  (o modelo aceito completa com as atividades do PT, ex.: testes de integração, documentação final,
  repasse e encerramento). Não escreva status no título ("faltam…"); o que falta é tratado na
  narrativa (o que foi feito) e em Divergências (prazo e impacto).
- Segunda linha: cabeçalho `ATIVIDADES DA MACROENTREGA | DATA DE ACEITAÇÃO`.
- Terceira linha: a **narrativa dentro da célula** da esquerda e a data de aceite (ou
  `Em andamento`) na célula da direita. Nunca "(narrativa abaixo)" com o texto fora da tabela.

No arquivo Markdown use a tabela HTML do modelo (`assets/templates/relatorio-execucao-fisica.md`),
que comporta vários parágrafos na mesma célula e continua colável no Word.

**Limite: 5.000 caracteres (com espaços) por narrativa de ME.** Cada ME tem o seu teto. Os aceitos
ficaram entre 3.200 e 4.300. Marque o bloco com `<!-- limite: 5000 -->` para o verificador medir.

### Como escrever a narrativa de uma ME

Estilo e organização do documento aceito:

- **Bloco corrido e cronológico, sem subtítulos.** Conte o que aconteceu na ordem em que
  aconteceu ("a equipe iniciou…", "a partir daí…", "concomitantemente…", "por fim…"). Nada de
  rótulos em negrito por tema ("ETL.", "Qualidade."), e nenhuma subseção extra como "Pendências
  desta macroentrega": pendências são tratadas em Divergências.
- **Abra pelo relato da execução.** O primeiro parágrafo diz o que a equipe começou a fazer; ele
  não antecipa pendências nem remete às Divergências.
- **Linguagem institucional, de negócio, clara e objetiva, com o mínimo de jargão técnico.**
  Descreva o que o **projeto** fez: reuniões e inspeções com o cliente, visitas técnicas,
  colaboração com a TI da empresa, metodologia (Scrum, sprints quinzenais), validações. Evite
  contagens de testes, nomes de tabelas, de componentes e de tecnologias. Explique siglas na
  primeira ocorrência.
- **Passado**, relato de execução. Se uma parte só existe em ambiente de desenvolvimento ou com
  dados simulados, diga em palavras de negócio ("validado em ambiente de desenvolvimento, com dados
  de teste"), sem detalhar o mecanismo.
- **Fechamento com a fórmula de entregáveis e validação.** Termine sempre com:

  - ME aceita: "Como entregáveis desta macroentrega foram disponibilizados {{ENTREGÁVEIS}}. O
    cliente avaliou e validou os entregáveis como evidências físicas da macroentrega, aceita em
    {{DD/MM/AAAA}}."
  - ME em andamento: o status e a previsão de conclusão: "Esta macroentrega segue em andamento,
    com previsão de conclusão em {{MÊS/ANO}}." (liste também os entregáveis já disponibilizados).
  - Se a validação do cliente ou a data de aceite não foram informadas, **não afirme**: mantenha a
    fórmula entre `{{ }}` (ex.: `{{O cliente avaliou e validou … aceita em DD/MM/AAAA}}`) para que o
    verificador a sinalize. Não use "a validação formal ainda será registrada".

Exemplo de abertura de uma ME em curso:

> Iniciada a macroentrega 03, a equipe conduziu reuniões semanais de acompanhamento com a TI da
> empresa parceira e, a partir daí, passou a desenvolver a aplicação web que será usada pelos
> operadores no registro das paradas. [...]

Quando a ME atravessa dois relatórios, o segundo abre assim:

> Uma parte das atividades da macroentrega 03 foi descrita no Relatório de Execução Física do
> período anterior ({{PERÍODO}}). As atividades que abrangem este relatório foram [...]

### Divergências em relação ao planejado

**Um parágrafo curto, com foco em prazo e impacto.** Cronograma é o assunto: o que atrasou, a data
prevista, a data real (ou nova previsão) e o impacto no restante do projeto. Sem lista numerada e
sem esquema fixo de "gap técnico" (previsto/feito/causa/validação/recomendação).

- Nenhuma: escreva `N/A`.
- Atraso de ME ou atividade:

> A macroentrega ME02, inicialmente prevista para {{DATA_PREVISTA}}, teve sua finalização em
> {{DATA_REAL}}. O atraso não irá comprometer o andamento e a conclusão do projeto.

- Atividade ainda não executada (o que antes ia em "Pendências"): diga a data prevista, a nova
  previsão e o impacto, no mesmo parágrafo.

> A atividade {{TÍTULO_DO_PT}}, prevista para {{MÊS/ANO}}, deve ser concluída em {{MÊS/ANO}}, em
> razão de {{CAUSA_EM_UMA_FRASE}}. {{O_IMPACTO_NO_PROJETO}}.

- Resultado técnico abaixo do esperado (ex.: um modelo que não atingiu o objetivo): registre em uma
  ou duas frases dentro do mesmo parágrafo, com a validação do cliente se houve; o detalhe técnico
  fica no relatório de análise de modelos. **Não omita**: omitir é o risco real.
- Se o usuário não confirmou a validação do cliente, não afirme que houve.

### Campos que só uma pessoa preenche

Código do projeto, coordenador e CPF dele, datas de vigência, período de referência, datas de
emissão e de aceite (o que não consta na ficha). Mantenha como `{{...}}` até alguém informar; no
`.docx` eles saem destacados em amarelo.
