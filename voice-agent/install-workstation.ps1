param(
    [string]$ComputeHost = '',
    [string]$ComputeUser = '',
    [string]$SshIdentity = '',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Voice = Join-Path $Repo 'voice-agent'
$State = Join-Path $Repo '.state\voice-agent'
$Venv = Join-Path $State 'venv'
$TaskName = 'ClaudeUiMod-Voice'

function Stop-VoiceTask {
    # Disabled first: the watchdog trigger would otherwise restart the old
    # definition between this stop and the re-register or unregister below.
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    $TokenPath = Join-Path $State 'token'
    $ConfigPath = Join-Path $State 'workstation.json'
    if ((Test-Path $TokenPath) -and (Test-Path $ConfigPath)) {
        try {
            $RuntimeConfig = Get-Content -Raw $ConfigPath | ConvertFrom-Json
            $ApiPort = if ($RuntimeConfig.port) { [int]$RuntimeConfig.port } else { 18764 }
            $Headers = @{ Authorization = 'Bearer ' + (Get-Content -Raw $TokenPath).Trim() }
            Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$ApiPort/shutdown" `
                -Headers $Headers -ContentType 'application/json' -Body '{}' -TimeoutSec 2 | Out-Null
            for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
                Start-Sleep -Milliseconds 100
                $Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                if (-not $Existing -or $Existing.State -eq 'Ready') { return }
            }
        } catch {}
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

if ($Remove) {
    Stop-VoiceTask
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task $TaskName. Audio and configuration remain in $State."
    exit 0
}

New-Item -ItemType Directory -Force -Path $State | Out-Null
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) {
    & python -m venv --system-site-packages $Venv
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the workstation Python environment.' }
}
$Python = Join-Path $Venv 'Scripts\python.exe'
& $Python -c 'import torch, torchaudio' 2>$null
if ($LASTEXITCODE -ne 0) {
    & $Python -m pip install --disable-pip-version-check --index-url https://download.pytorch.org/whl/cpu `
        'torch==2.7.1+cpu' 'torchaudio==2.7.1+cpu'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install CPU Torch for Silero VAD.' }
}
& $Python -m pip install --disable-pip-version-check -r (Join-Path $Voice 'requirements-workstation.txt')
if ($LASTEXITCODE -ne 0) { throw 'Failed to install workstation voice dependencies.' }

$ComputeToken = Join-Path $State 'compute-token'
if (-not (Test-Path $ComputeToken)) {
    $Bytes = New-Object byte[] 48
    $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Random.GetBytes($Bytes) } finally { $Random.Dispose() }
    [IO.File]::WriteAllText($ComputeToken, [Convert]::ToBase64String($Bytes))
}

$ConfigPath = Join-Path $State 'workstation.json'
if (-not (Test-Path $ConfigPath)) {
    $Config = Get-Content -Raw (Join-Path $Voice 'workstation.example.json') | ConvertFrom-Json
    $Config.computeTokenFile = $ComputeToken
    if ($ComputeHost) { $Config.sshHost = $ComputeHost }
    if ($ComputeUser) { $Config.sshUser = $ComputeUser }
    if ($SshIdentity) { $Config.sshIdentity = $SshIdentity }
    [IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
}

$LogPath = Join-Path $State 'companion.log'
# The task runs guard.cs, which relaunches the companion the instant it exits
# while the task is enabled. RestartOnFailure only covers a failed launch.
$Guard = Join-Path $State 'voice-guard.exe'
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Action = New-ScheduledTaskAction -Execute $Guard -Argument ('"' + $Repo + '" "' + $TaskName + '"') -WorkingDirectory $Repo
# The every-minute trigger restarts a killed guard, which adopts the running
# companion; IgnoreNew makes it a no-op while the guard runs. An omitted
# repetition duration is indefinite. To keep voice down, Disable-ScheduledTask.
$Watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$Watchdog.Repetition.StopAtDurationEnd = $false
$Trigger = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), $Watchdog)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings `
    -Description 'Local microphone capture, durable voice journal, and speech tunnel for claude-ui-mod.'
Stop-VoiceTask
& $Csc -nologo -target:winexe -optimize+ -r:System.Management.dll -r:Microsoft.CSharp.dll -r:System.Core.dll `
    "-out:$Guard" (Join-Path $Voice 'guard.cs')
if ($LASTEXITCODE -ne 0) { throw 'Failed to build the voice guard.' }
Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$Ready = $false
$CompanionToken = Join-Path $State 'token'
$RuntimeConfig = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$ApiPort = if ($RuntimeConfig.port) { [int]$RuntimeConfig.port } else { 18764 }
for ($Attempt = 0; $Attempt -lt 90; $Attempt++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $CompanionToken)) { continue }
    try {
        $Headers = @{ Authorization = 'Bearer ' + (Get-Content -Raw $CompanionToken).Trim() }
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/healthz" -Headers $Headers -TimeoutSec 2
        if ($Health.ok -and $Health.capture.ready) { $Ready = $true; break }
    } catch {}
}
if (-not $Ready) { throw "Voice companion did not become healthy. Read $LogPath and the scheduled task result." }

Write-Host "Voice companion installed and healthy."
Write-Host "Configuration: $ConfigPath"
Write-Host "Durable audio: $(Join-Path $State 'audio')"
Write-Host "Compute token: $ComputeToken (copy this file to the compute service; do not paste it into source or logs)"
Write-Host "List capture devices with: $Python $(Join-Path $Voice 'workstation.py') --list-devices"
