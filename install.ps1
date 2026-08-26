# claude-ui-mod :: register the update watcher as a logon scheduled task.
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'ClaudeUiMod-Watcher'
$ModDir   = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Uninstall) {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "removed scheduled task $TaskName"
    } catch {
        Write-Host "no scheduled task named $TaskName"
    }
    return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not on PATH" }

# wscript stub so the watcher runs with no console window
$vbs = Join-Path $ModDir 'watch-hidden.vbs'
$vbsBody = @"
Set s = CreateObject("WScript.Shell")
s.Run """$node"" ""$ModDir\watch.js""", 0, False
"@
Set-Content -Path $vbs -Value $vbsBody -Encoding ascii

$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $ModDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "registered scheduled task $TaskName"
Write-Host "starting it now..."
Start-ScheduledTask -TaskName $TaskName
Write-Host "log: $ModDir\watch.log"
