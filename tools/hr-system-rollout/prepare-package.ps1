param(
  [Parameter(Mandatory = $true)]
  [string]$SourceRoot,
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,
  [string]$Python = "C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe",
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$output = [System.IO.Path]::GetFullPath($OutputRoot)
$pdfRoot = Join-Path $output 'pdf'
New-Item -ItemType Directory -Force -Path $pdfRoot | Out-Null

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$word.AutomationSecurity = 3

try {
  $documents = Get-ChildItem -LiteralPath $source -Recurse -File -Filter '*.docx' |
    Where-Object { $_.FullName -ne (Join-Path $source 'HR\01_FORMS\01_Recruit\GS-HR-101.docx') }

  $completed = 0
  foreach ($document in $documents) {
    $relative = [System.IO.Path]::GetRelativePath($source, $document.FullName)
    $relativePdf = [System.IO.Path]::ChangeExtension($relative, '.pdf')
    $target = Join-Path $pdfRoot $relativePdf
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null

    if ($Force -or -not (Test-Path -LiteralPath $target) -or
        (Get-Item -LiteralPath $target).LastWriteTimeUtc -lt $document.LastWriteTimeUtc) {
      $open = $word.Documents.Open($document.FullName, $false, $true)
      try {
        foreach ($table in $open.Tables) {
          $table.AllowAutoFit = $true
          $table.AutoFitBehavior(2)
          if ($table.NestingLevel -eq 1) {
            $pageSetup = $table.Range.Sections.Item(1).PageSetup
            $usableWidth = $pageSetup.PageWidth - $pageSetup.LeftMargin - $pageSetup.RightMargin
            $table.Rows.WrapAroundText = $false
            $table.Rows.Alignment = 0
            $table.Rows.SetLeftIndent(0, 0)
            $table.PreferredWidthType = 3
            $table.PreferredWidth = $usableWidth
          }
        }
        $open.ExportAsFixedFormat($target, 17, $false, 0, 0, 1, 9999, 0, $true, $true, 1, $true, $true, $false)
      }
      finally {
        $open.Close($false)
      }
    }

    $completed += 1
    if (($completed % 25) -eq 0) {
      Write-Output "Rendered $completed of $($documents.Count) PDFs."
    }
  }
}
finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null
}

& $Python (Join-Path $PSScriptRoot 'build-manifest.py') --source-root $source --pdf-root $pdfRoot --output-root $output
if ($LASTEXITCODE -ne 0) { throw 'HR package manifest validation failed.' }
