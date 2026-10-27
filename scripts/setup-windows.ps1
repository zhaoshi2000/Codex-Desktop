# Bootstrap only. No system-wide installation or administrator elevation.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host 'AstroGate Codex: local Windows x64 setup'
Write-Host 'Downloads: Node.js (when needed) from nodejs.org; Codex 0.162.1 from the npm registry.'
Write-Host 'No API key is requested. No existing Codex configuration is overwritten.'
$answer = Read-Host 'Continue with these downloads? [Y/N]'
if ($answer -notmatch '^[Yy]$') { Write-Host 'Cancelled.'; exit 1 }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This bootstrap targets Windows x64 only.' }
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$portableNode = Join-Path $runtime 'node\node.exe'
$node = $null
if (Test-Path $portableNode) { $node = $portableNode }
elseif (Get-Command node.exe -ErrorAction SilentlyContinue) { $node = (Get-Command node.exe).Source }
$usable = $false
if ($node) {
    & $node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
    $usable = $LASTEXITCODE -eq 0
}
if (-not $usable) {
    Write-Host 'Downloading portable Node.js 22 x64...'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
    $entry = $index | Where-Object { $_.version -match '^v22\.' -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
    if (-not $entry -or $entry.version -notmatch '^v22\.\d+\.\d+$') { throw 'Could not resolve a valid Node.js 22 release.' }
    $name = "node-$($entry.version)-win-x64.zip"
    $base = "https://nodejs.org/dist/$($entry.version)"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 60).Content
    $line = $checksums -split "`n" | Where-Object { $_ -match ('\s+' + [Regex]::Escape($name) + '\s*$') } | Select-Object -First 1
    if (-not $line) { throw 'Missing official SHA256 checksum; download aborted.' }
    $expected = ($line.Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA256 checksum.' }
    $zip = Join-Path $runtime $name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $zip -TimeoutSec 600
    $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash
    if ($actual -ine $expected) { Remove-Item -LiteralPath $zip; throw 'SHA256 verification failed.' }
    $stage = Join-Path $runtime ('node-stage-' + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $stage
    $extracted = Join-Path $stage $name.Replace('.zip','')
    $destination = Join-Path $runtime 'node'
    if (Test-Path $destination) { Move-Item -LiteralPath $destination -Destination (Join-Path $runtime ('node-backup-' + (Get-Date -Format 'yyyyMMddHHmmss')) ) }
    Move-Item -LiteralPath $extracted -Destination $destination
    Remove-Item -LiteralPath $stage -Recurse -Force
    Remove-Item -LiteralPath $zip
    $node = $portableNode
}
$nodeDir = Split-Path -Parent $node
$env:PATH = "$nodeDir;$env:PATH"
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = (Get-Command npm.cmd -ErrorAction Stop).Source }
$engineDir = Join-Path $runtime 'codex'
Write-Host 'Installing official Codex 0.162.1 into the project runtime...'
& $npm install --prefix $engineDir --no-audit --no-fund '@openai/codex@0.162.1'
if ($LASTEXITCODE -ne 0) { throw 'Codex installation failed. Check network and npm settings, then retry.' }
& $node (Join-Path $PSScriptRoot 'check-engine.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Codex was downloaded but could not pass the local version check.' }
Write-Host 'Ready. Start.cmd launches the graphical workbench.'
