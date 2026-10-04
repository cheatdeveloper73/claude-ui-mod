param([Parameter(Mandatory=$true)][string]$ConfigFile, [switch]$Once)
$ErrorActionPreference = 'Stop'
$config = [IO.File]::ReadAllText($ConfigFile) | ConvertFrom-Json
if ($env:COMPUTERNAME -ine $config.authorityHost) { throw 'Credential publisher refused on a reader host.' }
$state = Join-Path $config.modRoot '.state'
$viewFile = Join-Path $state 'credential-access-view.json'
$publisher = Join-Path $config.modRoot 'scripts\publish-credential-view.mjs'
$session = $null
$lastHash = $null
$sequence = 0
function Set-Receipt([string]$Status, [string]$ViewHash) {
    $receipt = @{ version=1; authorityHost=$env:COMPUTERNAME; guestHost=$config.guestHost; utc=[DateTime]::UtcNow.ToString('o'); sequence=$script:sequence; status=$Status; viewHash=$ViewHash }
    $file = Join-Path $state 'credential-handoff-status.json'
    $tmp = $file + '.tmp-' + $PID
    [IO.File]::WriteAllText($tmp, ($receipt | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Copy($tmp, $file, $true)
}
function Invoke-PublishNode {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $config.node
    $info.Arguments = '"' + $publisher + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $config.modRoot
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(90000)) { $process.Kill(); throw 'Credential publication timed out.' }
        # Only this entry point's fixed status strings are written; native errors
        # and remoting exception bodies can contain serialized secret arguments.
        [IO.File]::WriteAllText((Join-Path $state 'credential-publish-node.log'), $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult())
        if ($process.ExitCode -ne 0) { throw 'Credential publication failed.' }
    } finally { $process.Dispose() }
}
try {
    do {
        try {
            Invoke-PublishNode
            $raw = [IO.File]::ReadAllText($viewFile)
            $hash = (Get-FileHash -LiteralPath $viewFile -Algorithm SHA256).Hash
            if ($hash -ne $lastHash -or -not $session -or $session.State -ne 'Opened') {
                if (-not $session -or $session.State -ne 'Opened') {
                    if ($session) { Remove-PSSession $session; $session=$null }
                    $credential = Import-Clixml $config.remotingCredentialFile
                    $session = New-PSSession -ComputerName $config.guestAddress -Port $config.guestPort -Credential $credential -Authentication Negotiate -SessionOption (New-PSSessionOption -OpenTimeout 10000 -OperationTimeout 45000)
                }
                $receipt = Invoke-Command -Session $session -ArgumentList $config.guestHost,$config.authorityHost,$config.guestModRoot,$raw,$hash -ScriptBlock {
                    param($guestHost,$authorityHost,$modRoot,$raw,$expectedHash)
                    $ErrorActionPreference='Stop'
                    if ($env:COMPUTERNAME -ine $guestHost) { throw 'Wrong credential reader host.' }
                    $view = $raw | ConvertFrom-Json
                    if ($view.version -ne 1 -or $view.authorityHost -cne $authorityHost -or $view.openai.refresh_token -or $view.claude.refreshToken) { throw 'Invalid access-only view.' }
                    $file = Join-Path $modRoot '.state\credential-access-view.json'
                    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
                    if (Test-Path -LiteralPath $file) {
                        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $expectedHash) { return $expectedHash }
                        [IO.File]::Copy($file, ($file+'.backup-'+[Guid]::NewGuid().ToString()), $false)
                    }
                    $tmp = $file + '.tmp-' + [Guid]::NewGuid().ToString()
                    [IO.File]::WriteAllText($tmp,$raw,[Text.UTF8Encoding]::new($false))
                    if (Test-Path -LiteralPath $file) { [IO.File]::Replace($tmp,$file,[NullString]::Value) } else { [IO.File]::Move($tmp,$file) }
                    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
                    if ($actual -ne $expectedHash) { throw 'Credential view identity mismatch.' }
                    return $actual
                }
                if ($receipt -ne $hash) { throw 'Credential publication receipt mismatch.' }
                $lastHash = $hash
                $sequence++
            }
            Set-Receipt 'published' $lastHash
            if ($Once) { 'Credential view published and verified.' }
        } catch {
            Set-Receipt 'retrying' $lastHash
            if ($Once) { throw 'Credential handoff publication failed; sanitized status retained.' }
            if ($session) { Remove-PSSession $session; $session=$null }
        }
        if (-not $Once) { Start-Sleep -Seconds 10 }
    } while (-not $Once)
} finally { if ($session) { Remove-PSSession $session } }
