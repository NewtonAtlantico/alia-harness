RELATÓRIO DE EXECUÇÃO FÍSICA DO PROJETO
UNIDADE EMBRAPII {{UNIDADE_EMBRAPII}}
{{CODIGO_PROJETO}} | {{NN}}/{{AAAA}}

<!-- Preencha todos os campos a partir da ficha do projeto (PT + dados da Unidade + dados informados).
     Só deixe {{...}} no que ninguém forneceu. Nunca deixe como {{...}} o que está na ficha. -->
Projeto: {{CODIGO_PROJETO}} – {{TITULO_DO_PROJETO}}
Responsável: {{NOME_DO_COORDENADOR}}
CPF: {{CPF_PREENCHER_NO_DOCUMENTO_OFICIAL}}
Período de Vigência do Projeto: {{DD}} de {{MES}} de {{AAAA}} até {{DD}} de {{MES}} de {{AAAA}}
Período de Referência: {{NN}}/{{AAAA}}
Prestação de Contas {{Parcial | Final}}
Contador: {{NOME_DO_CONTADOR}}
CRC: {{CRC}}

| | |
|---|---|
| COORDENADOR DO PROJETO: | {{NOME_DO_COORDENADOR}} |
| EMPRESAS CONTRATANTES: | {{CNPJ}} - {{RAZAO_SOCIAL}} |

<!-- Repita a tabela abaixo para cada ME do período. Título da ME = TODAS as atividades do PT para ela
     (executadas ou não), em lista de marcadores, cada uma terminando em ";" e a última em ".".
     Sem prefixo "/", sem status no título. -->

<table>
<tr><td colspan="2">

**MACROENTREGA: ME{{NN}}**

- {{ATIVIDADE_1_TITULO_EXATO_DO_PT}};
- {{ATIVIDADE_2_TITULO_EXATO_DO_PT}}.

</td></tr>
<tr><th>ATIVIDADES DA MACROENTREGA</th><th>DATA DE ACEITAÇÃO</th></tr>
<tr><td>

<!-- limite: 5000 -->
{{ABERTURA_PELO_RELATO_DA_EXECUCAO: o que a equipe começou a fazer, sem antecipar pendências}}

{{RELATO_CRONOLOGICO_SEM_SUBTITULOS: "a equipe iniciou… a partir daí… concomitantemente… por fim…", em linguagem institucional de gestão (reuniões, visitas técnicas, colaboração com a TI do cliente, metodologia, validações), no passado, com o mínimo de jargão técnico}}

{{FECHAMENTO — ME aceita: "Como entregáveis desta macroentrega foram disponibilizados … O cliente avaliou e validou os entregáveis como evidências físicas da macroentrega, aceita em DD/MM/AAAA." — ME em andamento: "Esta macroentrega segue em andamento, com previsão de conclusão em MÊS/ANO."}}
<!-- /limite -->

</td><td>{{DD/MM/AAAA ou "Em andamento"}}</td></tr>
</table>

DIVERGÊNCIAS EM RELAÇÃO AO PLANEJADO

<!-- "N/A" se não houve. Caso contrário, UM parágrafo curto focado em prazo e impacto:
     o que atrasou, data prevista, data real (ou nova previsão) e impacto no projeto. Sem lista numerada. -->
{{N/A_OU_PARAGRAFO_DE_PRAZO_E_IMPACTO}}

Emitido em {{DD}} de {{MES}} de {{AAAA}}

<!-- Duas assinaturas, como no modelo aceito: signatário da Unidade (sem cargo) e contador com CRC.
     Valores vêm da ficha do projeto (dados da Unidade). -->
{{NOME_DO_SIGNATARIO_DA_UNIDADE}}
Unidade EMBRAPII

{{NOME_DO_CONTADOR}}
CRC: {{CRC}}

<!-- Rodapé institucional: scripts/build_docx.py lê esta linha e aplica no rodapé de todas as páginas
     do .docx (paginação automática). Não aparece no corpo do texto. -->
Rodapé: {{ENDERECO_DA_UNIDADE_EMBRAPII}} · Página N de TOTAL · {{VERSAO_DO_MODELO, ex.: Versão_A.1 - Out/2023 (confirmar se vigente)}}
