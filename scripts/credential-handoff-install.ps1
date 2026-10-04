param([Parameter(Mandatory=$true)][string]$ConfigFile)
$ErrorActionPreference='Stop'
$config=[IO.File]::ReadAllText($ConfigFile)|ConvertFrom-Json
if($env:COMPUTERNAME -ine $config.authorityHost){throw 'Credential publisher must be installed on its authority host.'}
$state=Join-Path $config.modRoot '.state'
$script=Join-Path $config.modRoot 'scripts\credential-handoff-publish.ps1'
$log=Join-Path $state 'credential-handoff-service.log'
$launcher=Join-Path $state 'credential-handoff-hidden.vbs'
if(-not(Test-Path -LiteralPath $script)){throw 'Credential publisher source is missing.'}
# wscript is a GUI-subsystem launcher; style 0 is applied before PowerShell can
# allocate a visible console. The publisher and every Node child redirect output.
$ps="& '"+$script.Replace("'","''")+"' -ConfigFile '"+$ConfigFile.Replace("'","''")+"' *> '"+$log.Replace("'","''")+"'"
$command='powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "'+$ps+'"'
$vbs='WScript.Quit CreateObject("WScript.Shell").Run("'+$command.Replace('"','""')+'", 0, True)'
if(Test-Path -LiteralPath $launcher){[IO.File]::Copy($launcher,$launcher+'.backup-'+[Guid]::NewGuid().ToString(),$false)}
[IO.File]::WriteAllText($launcher,$vbs,[Text.UTF8Encoding]::new($false))
$taskName='ClaudeUiMod-CredentialPublisher'
$description='Owned access-only credential publication for the remote agent stack.'
$tasks=@(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
if($tasks.Count -gt 1){throw 'Ambiguous credential publisher task ownership.'}
if($tasks.Count){
    if($tasks[0].Description -ne $description -or $tasks[0].Actions.Count -ne 1 -or $tasks[0].Actions[0].Arguments -ne ('"'+$launcher+'"')){throw 'Foreign credential publisher task retained.'}
}else{
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('"'+$launcher+'"') -WorkingDirectory $config.modRoot
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden -Priority 7 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description|Out-Null
}
Start-ScheduledTask -TaskName $taskName
'Credential publisher installed and started without a console window.'
