# restart.ps1 -- stop the desktop app completely, then start it again
#
# Sequence:
#   1. wait DelayMs (lets the HTTP response and the UI countdown land)
#   2. validate the target pid really is the DSH desktop app
#   3. taskkill /PID <app> /F   -- main process only; the Host dies with it
#   4. wait for the Host pid to disappear; force-kill its tree only if it lingers
#   5. wait until the app pid is gone, then Start-Process the exe
#
# NOTE: do NOT use "Split-Path -LiteralPath ... -Parent" here -- PS 5.1 rejects that
# combination (ambiguous parameter set) and returns $null, which then breaks
# Start-Process. Use System.IO.Path instead.
param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][int]$HostPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Log,
  [int]$DelayMs = 2500
)

$ErrorActionPreference = 'Continue'

function Say([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  try { Add-Content -LiteralPath $Log -Value $line -Encoding UTF8 } catch { }
}

Say ('restarter up: pid=' + $PID + ' app=' + $AppPid + ' host=' + $HostPid + ' delay=' + $DelayMs + 'ms')
Start-Sleep -Milliseconds $DelayMs

$app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
if ($null -eq $app) {
  Say 'target app process is gone; nothing to restart, abort'
  exit 1
}

if ($app.ProcessName -notlike 'DeepSeek*') {
  Say ('refuse to kill unexpected process: ' + $app.ProcessName)
  exit 1
}

Say ('terminating app pid ' + $AppPid)
try { & taskkill.exe /PID $AppPid /F | Out-Null } catch { Say ('taskkill failed: ' + $_.Exception.Message) }

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  if ($null -eq (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 150
}

if ($null -ne (Get-Process -Id $AppPid -ErrorAction SilentlyContinue)) {
  Say 'app still alive after 12s; abort instead of launching a second instance'
  exit 1
}
Say 'app exited'

# Host child: normally dies with the app. Give it time, then force the tree.
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  if ($null -eq (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if ($null -ne (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) {
  Say ('host ' + $HostPid + ' still alive; force kill tree')
  try { & taskkill.exe /PID $HostPid /T /F | Out-Null } catch { }
  Start-Sleep -Milliseconds 600
}

Start-Sleep -Milliseconds 500
$dir = [System.IO.Path]::GetDirectoryName($Exe)
Say ('starting ' + $Exe + ' (cwd ' + $dir + ')')
try {
  if ([string]::IsNullOrEmpty($dir)) {
    $launched = Start-Process -FilePath $Exe -PassThru
  } else {
    $launched = Start-Process -FilePath $Exe -WorkingDirectory $dir -PassThru
  }
  Start-Sleep -Milliseconds 800
  Say ('launched pid ' + $launched.Id)
} catch {
  Say ('Start-Process failed: ' + $_.Exception.Message + ' -- retry with cmd start')
  try {
    & cmd.exe /c ('start "" "{0}"' -f $Exe) | Out-Null
    Say 'launched via cmd start'
  } catch {
    Say ('cmd start failed: ' + $_.Exception.Message)
  }
}
Say 'done'
