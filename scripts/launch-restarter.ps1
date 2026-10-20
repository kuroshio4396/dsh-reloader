# launch-restarter.ps1 -- create an orphaned restarter process (ASCII only: cmd/PS read this as ANSI)
#
# Why WMI: the Electron main process lives inside a Chromium job object, so any child it
# spawns (including this script) dies with it. Win32_Process.Create creates the new process
# under WmiPrvSE.exe instead, so the restarter outlives the app it is about to restart.
#
# NOTE: Win32_Process.Create takes a full command line -- the first token must be the
# executable. A command line that starts with arguments returns 9 (path not found).
param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][int]$HostPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$Log,
  [int]$DelayMs = 2500
)

$ErrorActionPreference = 'Stop'

$pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $pwsh)) { $pwsh = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' }

$argline = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -AppPid {2} -HostPid {3} -Exe "{4}" -Log "{5}" -DelayMs {6}' -f `
  $pwsh, $Script, $AppPid, $HostPid, $Exe, $Log, $DelayMs

try {
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $argline }
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
  exit 1
}

if ($null -eq $result -or $result.ReturnValue -ne 0) {
  $code = 0
  if ($null -ne $result) { $code = $result.ReturnValue }
  Write-Output ('ERR return=' + $code)
  exit 1
}

Write-Output ('PID ' + $result.ProcessId)
