<#
.SYNOPSIS
  Passo opcional (exige Microsoft Word instalado): atualiza índice e campos de um .docx gerado
  por build_docx.py, regrava o arquivo e exporta PDF para conferência visual.

.EXAMPLE
  powershell -File word_finalize.ps1 -Docx "embrapii\ME01\1. Documento de Concepção.docx"
  powershell -File word_finalize.ps1 -Docx doc.docx -SalvarDoc   # também grava doc.doc (Word 97-2003)

  O .docx continua sendo o formato recomendado para importar no Google Docs. O .doc só existe
  para quem exigir esse formato; ele sai do próprio Word, com a mesma formatação.
#>
param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [switch]$SemPdf,
  [switch]$SalvarDoc
)
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Docx).Path
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($path)
  $doc.Repaginate()
  foreach ($toc in @($doc.TablesOfContents)) { $toc.Update() }
  [void]$doc.Fields.Update()
  foreach ($s in $doc.Sections) {
    foreach ($hf in @($s.Headers) + @($s.Footers)) { [void]$hf.Range.Fields.Update() }
  }
  $doc.Save()
  if (-not $SemPdf) {
    $pdf = [System.IO.Path]::ChangeExtension($path, 'pdf')
    $doc.ExportAsFixedFormat($pdf, 17)   # 17 = wdExportFormatPDF
    Write-Output "PDF: $pdf"
  }
  if ($SalvarDoc) {
    $legacy = [System.IO.Path]::ChangeExtension($path, 'doc')
    $doc.SaveAs2($legacy, 0)             # 0 = wdFormatDocument (Word 97-2003)
    Write-Output "DOC: $legacy"
  }
  Write-Output ("Paginas: " + $doc.ComputeStatistics(2))
  $doc.Close($false)
} finally {
  $word.Quit()
}
