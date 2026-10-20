param(
  [ValidateSet('preflight','release','resume-ledger','failed-build-cleanup','forward-recovery','resume-recovery-ledger')]
  [string]$Mode = 'preflight',
  [switch]$ExecuteReviewedChange
)
$ErrorActionPreference = 'Stop'
$taskRoot = 'C:\Users\Jordan\Projects\SygShift-misty-timezone'
$taskProjectRef = 'eqkdfrbwtioiqtjsyglg'
$taskExpectedHost = 'aws-0-us-east-1.pooler.supabase.com'
$taskCli = 'C:\Users\Jordan\AppData\Local\pnpm\store\v11\links\@supabase\cli-windows-x64\2.121.0\f06c10d6d3690abb05702fdd53d5094a817bdd1903aa5e65deecb9f14ebef358\node_modules\@supabase\cli-windows-x64\bin\supabase.exe'
$taskPsql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$taskCandidateRoot = Join-Path $taskRoot 'docs\work-orders\2026-10-19-overnight\candidates'
$taskEvidenceRoot = Join-Path $taskRoot 'backups\overnight-2026-10-19'
$taskSecret = Join-Path $taskEvidenceRoot 'covering-index-native-connection.local'
$taskPasswordFile = Join-Path $taskEvidenceRoot 'covering-index-native.pgpass.local'
$taskCliError = Join-Path $taskEvidenceRoot 'covering-index-native-login.stderr.local'
$taskControlFile = Join-Path $taskCandidateRoot ('covering-index-' + $Mode + $(if ($Mode -eq 'preflight') { '.sql' } else { '.psql' }))
$taskNames = @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT','PGOPTIONS','PGCLIENTENCODING')
$taskPrevious = @{}
foreach ($taskName in $taskNames) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process') }
if ($Mode -ne 'preflight' -and -not $ExecuteReviewedChange) { throw 'Non-read-only mode requires explicit reviewed-change execution flag.' }
if ((Get-Location).Path -ne $taskRoot) { throw 'Run the native protocol from the exact reviewed repository root.' }
if ((Get-Content -LiteralPath (Join-Path $taskRoot 'supabase\.temp\project-ref') -Raw).Trim() -ne $taskProjectRef) { throw 'Linked Supabase project pin mismatch.' }
$taskArtifacts = Get-Content -LiteralPath (Join-Path $taskCandidateRoot 'covering-index-artifacts.json') -Raw | ConvertFrom-Json
foreach ($taskArtifact in $taskArtifacts.artifacts) {
  if ((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskArtifact.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskArtifact.sha256) { throw 'Reviewed online-index artifact hash mismatch.' }
}
if ($Mode -ne 'preflight') {
  $taskSourceName = if ($Mode -in @('forward-recovery','resume-recovery-ledger')) { '20261020002135_recover_active_shift_timekeeping_covering_index.sql' } else { '20261020001516_cover_active_shift_timekeeping_candidates.sql' }
  $taskActiveSource = Join-Path $taskRoot ('supabase\migrations\' + $taskSourceName)
  if (-not (Test-Path -LiteralPath $taskActiveSource)) { throw 'Reviewed source has not been promoted into the active forward migration tree.' }
  if ((Get-FileHash -LiteralPath $taskActiveSource -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskCandidateRoot $taskSourceName) -Algorithm SHA256).Hash) { throw 'Active and staged forward sources differ.' }
}
try {
  # Must own the CLI/native credential window: linked commands rotate this login.
  # Secret-bearing output is confined to ignored files and is never emitted.
  & $taskCli db dump --linked --dry-run 1> $taskSecret 2> $taskCliError
  if ($LASTEXITCODE -ne 0) { throw 'Authorized CLI native-connection initialization failed; protected diagnostics retained only during this invocation.' }
  $taskScript = Get-Content -LiteralPath $taskSecret -Raw
  $taskConnection = @{}
  foreach ($taskName in @('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE')) {
    $taskMatch = [regex]::Match($taskScript, '(?m)^export ' + $taskName + '=(.+)$')
    if (-not $taskMatch.Success) { throw 'Official native connection configuration incomplete.' }
    $taskConnection[$taskName] = $taskMatch.Groups[1].Value.Trim().Trim('"').Trim("'")
  }
  $taskPoolerPinned = $taskConnection.PGHOST -eq $taskExpectedHost -and $taskConnection.PGUSER -eq ('cli_login_postgres.' + $taskProjectRef)
  $taskDirectPinned = $taskConnection.PGHOST -eq ('db.' + $taskProjectRef + '.supabase.co') -and $taskConnection.PGUSER -eq 'cli_login_postgres'
  if ((-not $taskPoolerPinned -and -not $taskDirectPinned) -or $taskConnection.PGPORT -ne '5432' -or $taskConnection.PGDATABASE -ne 'postgres') { throw ('Native pin mismatch. Pooler=' + $taskPoolerPinned + '; direct=' + $taskDirectPinned + '; port=' + ($taskConnection.PGPORT -eq '5432') + '; database=' + ($taskConnection.PGDATABASE -eq 'postgres') + '.') }
  $taskEscape = { param([string]$Value) $Value.Replace('\','\\').Replace(':','\:') }
  $taskPasswordLine = (@('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD') | ForEach-Object { & $taskEscape $taskConnection[$_] }) -join ':'
  [System.IO.File]::WriteAllText($taskPasswordFile,$taskPasswordLine + "`n",[System.Text.UTF8Encoding]::new($false))
  foreach ($taskName in @('PGHOST','PGPORT','PGUSER','PGDATABASE')) { [Environment]::SetEnvironmentVariable($taskName,$taskConnection[$taskName],'Process') }
  [Environment]::SetEnvironmentVariable('PGPASSWORD',$null,'Process')
  $env:PGPASSFILE = $taskPasswordFile
  $env:PGSSLMODE = 'verify-full'
  $env:PGSSLROOTCERT = Join-Path $taskCandidateRoot 'supabase-prod-ca-2021.crt'
  $env:PGCONNECT_TIMEOUT = '15'
  $env:PGCLIENTENCODING = 'UTF8'
  $env:PGOPTIONS = '-c statement_timeout=30s -c lock_timeout=2s -c application_name=sygshift-covering-index-' + $Mode
  $taskStdout = Join-Path $taskEvidenceRoot ('covering-index-native-' + $Mode + '.txt')
  $taskStderr = Join-Path $taskEvidenceRoot ('covering-index-native-' + $Mode + '.stderr.local')
  & $taskPsql -X -w -v ON_ERROR_STOP=1 -A -t -f $taskControlFile 1> $taskStdout 2> $taskStderr
  if ($LASTEXITCODE -ne 0) { throw ('Native online-index ' + $Mode + ' refused/failed; inspect protected output and exact build state before any recovery or retry.') }
  [pscustomobject]@{Mode=$Mode;Succeeded=$true;Evidence=$taskStdout;Tls='verify-full/pinned Supabase Root 2021 CA';LockTimeout='2s';DdlStatementTimeout='30s';ReviewTimeout='8s unchanged'}
} finally {
  foreach ($taskPath in @($taskSecret,$taskPasswordFile,$taskCliError)) { if (Test-Path -LiteralPath $taskPath) { Remove-Item -LiteralPath $taskPath -Force } }
  foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process') }
  $taskScript=$null;$taskPasswordLine=$null;$taskConnection=$null
}
