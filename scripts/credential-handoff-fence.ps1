param([Parameter(Mandatory=$true)][string]$ConfigFile)
$ErrorActionPreference='Stop'
$config=[IO.File]::ReadAllText($ConfigFile)|ConvertFrom-Json
if($env:COMPUTERNAME -ine $config.authorityHost){throw 'Credential handoff must be controlled by its authority host.'}
$credential=Import-Clixml $config.remotingCredentialFile
$session=$null
try {
    $session=New-PSSession -ComputerName $config.guestAddress -Port $config.guestPort -Credential $credential -Authentication Negotiate -SessionOption (New-PSSessionOption -OpenTimeout 10000 -OperationTimeout 45000)
    Invoke-Command -Session $session -ArgumentList $config.guestHost,$config.authorityHost,$config.guestModRoot,$config.guestProfileRoot -ScriptBlock {
        param($guestHost,$authorityHost,$modRoot,$profileRoot)
        $ErrorActionPreference='Stop'
        if($env:COMPUTERNAME -ine $guestHost){throw 'Wrong credential reader host.'}
        # A canonical-looking C: alias may still point at the PC's source share.
        # Never fence through B:, a UNC path, or a reparse chain reaching either.
        $pending=New-Object Collections.Generic.Stack[string]
        $seen=New-Object Collections.Generic.HashSet[string]
        foreach($file in @($modRoot,(Join-Path $modRoot '.state'),(Join-Path $profileRoot '.codex\auth.json'),(Join-Path $profileRoot '.claude\.credentials.json'))){$pending.Push($file)}
        while($pending.Count){
            $file=$pending.Pop()
            if(-not $seen.Add($file)){continue}
            if($file -notmatch '^C:\\'){throw 'Credential reader path reaches a nonlocal mapping.'}
            $item=Get-Item -LiteralPath $file -Force
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){
                foreach($target in @($item.Target)){
                    if($target -notmatch '^C:\\'){throw 'Credential reader alias reaches a nonlocal mapping.'}
                    $pending.Push($target)
                }
            }
            $parent=Split-Path -Path $file -Parent
            if($parent -and $parent -ne $file){$pending.Push($parent)}
        }
        $writers=@(Get-CimInstance Win32_Process|Where-Object {
            $_.CommandLine -and ($_.CommandLine -match '[\\/]router[\\/](supervisor|index)\.mjs' -or $_.Name -in @('codex.exe','claude.exe'))
        })
        if($writers.Count){throw 'Credential reader fence refused while copied credential consumers are running.'}
        $state=Join-Path $modRoot '.state'
        $viewFile=Join-Path $state 'credential-access-view.json'
        $view=[IO.File]::ReadAllText($viewFile)|ConvertFrom-Json
        if($view.version -ne 1 -or $view.authorityHost -cne $authorityHost -or
            $view.openai.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -or
            $view.claude.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()){
            throw 'A working access-only authority route is required before fencing copies.'
        }
        $backups=Join-Path $state ('credential-handoff-backups\'+[Guid]::NewGuid().ToString())
        [void][IO.Directory]::CreateDirectory($backups)
        $records=New-Object Collections.Generic.List[object]
        function Write-AtomicBackup($file,$value){
            $tag=[Guid]::NewGuid().ToString()
            $backup=Join-Path $backups ($tag+'.json')
            [IO.File]::Copy($file,$backup,$false)
            $before=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
            $tmp=$file+'.tmp-'+$tag
            [IO.File]::WriteAllText($tmp,($value|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
            [IO.File]::Replace($tmp,$file,[NullString]::Value)
            $item=Get-Item -LiteralPath $file
            $records.Add([pscustomobject]@{file=$file;backup=$backup;beforeHash=$before;hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash;mtimeUtc=$item.LastWriteTimeUtc.ToString('o');bytes=$item.Length})
        }
        $files=@(Join-Path $profileRoot '.codex\auth.json')
        $profiles=Join-Path $state 'openai-accounts'
        if(Test-Path -LiteralPath $profiles){$files+=@(Get-ChildItem -LiteralPath $profiles -Filter '*.json' -File|Select-Object -ExpandProperty FullName)}
        foreach($file in $files){
            if(-not(Test-Path -LiteralPath $file)){throw 'Copied OpenAI credential is missing.'}
            $value=[IO.File]::ReadAllText($file)|ConvertFrom-Json
            if($value.tokens.PSObject.Properties['refresh_token']){
                $value.tokens.PSObject.Properties.Remove('refresh_token')
                Write-AtomicBackup $file $value
            }
        }
        $claudeFile=Join-Path $profileRoot '.claude\.credentials.json'
        $claude=[IO.File]::ReadAllText($claudeFile)|ConvertFrom-Json
        if($claude.claudeAiOauth.PSObject.Properties['refreshToken']){
            $claude.claudeAiOauth.PSObject.Properties.Remove('refreshToken')
            Write-AtomicBackup $claudeFile $claude
        }
        $roleFile=Join-Path $state 'credential-authority.json'
        $role=@{version=1;authorityHost=$authorityHost;viewFile=$viewFile}
        if(Test-Path -LiteralPath $roleFile){Write-AtomicBackup $roleFile $role}
        else{[IO.File]::WriteAllText($roleFile,($role|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
        $receipt=@{version=1;authorityHost=$authorityHost;readerHost=$guestHost;utc=[DateTime]::UtcNow.ToString('o');consumerCount=$writers.Count;records=@($records.ToArray());backupRoot=$backups}
        [IO.File]::WriteAllText((Join-Path $state 'credential-handoff-fence.json'),($receipt|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
        $receipt|ConvertTo-Json -Depth 10
    }
} finally {if($session){Remove-PSSession $session}}
