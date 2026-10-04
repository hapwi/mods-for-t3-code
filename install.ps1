param([string]$T3Directory)
$ErrorActionPreference = 'Stop'
$repository = 'hapwi/mods-for-t3-code'
$dataDirectory = if ($env:MODS_FOR_T3_DATA) { $env:MODS_FOR_T3_DATA } else { Join-Path $env:APPDATA 'Mods for T3 Code' }
$tools = Join-Path $dataDirectory 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if ($node) {
  & $node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=18?0:1)'
  if ($LASTEXITCODE -ne 0) { $node = $null }
}
$work = Join-Path $tools ('download-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if (!$node) {
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $checksums = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
    $pattern = '(?m)^([a-f0-9]{64})\s+(node-v[^\s]+-win-' + $architecture + '\.zip)\s*$'
    $match = [regex]::Match($checksums, $pattern)
    if (!$match.Success) { throw 'Node download is unavailable.' }
    $filename = $match.Groups[2].Value
    $zip = Join-Path $work $filename
    Invoke-WebRequest "https://nodejs.org/dist/latest-v24.x/$filename" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $match.Groups[1].Value) { throw 'Node checksum mismatch.' }
    Expand-Archive $zip -DestinationPath $work
    $nodeFolder = [IO.Path]::GetFileNameWithoutExtension($filename)
    $runtime = Join-Path $tools $nodeFolder
    if (!(Test-Path $runtime)) { Move-Item (Join-Path $work $nodeFolder) $runtime }
    $node = Join-Path $runtime 'node.exe'
  }
  $commit = Invoke-RestMethod "https://api.github.com/repos/$repository/commits/main"
  if ($commit.sha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid repository revision.' }
  $revision = $commit.sha
  $zip = Join-Path $work 'source.zip'
  Invoke-WebRequest "https://codeload.github.com/$repository/zip/$revision" -OutFile $zip
  Expand-Archive $zip -DestinationPath $work
  $tool = Join-Path $tools "package-$revision"
  if (!(Test-Path $tool)) {
    $source = Join-Path $work "mods-for-t3-code-$revision"
    $runtimePackage = Join-Path $work 'runtime-package'
    New-Item -ItemType Directory -Path $runtimePackage | Out-Null
    Copy-Item (Join-Path $source 'dist') -Destination $runtimePackage -Recurse
    Copy-Item (Join-Path $source 'package.json'), (Join-Path $source 'LICENSE') -Destination $runtimePackage
    Move-Item $runtimePackage $tool
  }
  $cli = Join-Path $tool 'dist/cli.mjs'
  if ($T3Directory) { & $node $cli install --windows-dir $T3Directory } else { & $node $cli install }
  if ($LASTEXITCODE -ne 0) { throw 'The patch was not installed. Any failed replacement is rolled back.' }
  $launcher = Join-Path $tools 'mods-for-t3-code.cmd'
  # Percent characters must be doubled inside a cmd script's literal paths.
  $safeNode = $node.Replace('%', '%%')
  $safeCli = $cli.Replace('%', '%%')
  $safeData = $dataDirectory.TrimEnd('\').Replace('%', '%%')
  Set-Content $launcher (@(
    '@echo off',
    ('set "MODS_FOR_T3_DATA=' + $safeData + '"'),
    ('"' + $safeNode + '" "' + $safeCli + '" %*')
  ) -join "`r`n")
  # Retire only our old shortcut, preserving the user's normal T3 shortcut.
  $legacyShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mods for T3 Code.lnk'
  if (Test-Path $legacyShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($legacyShortcut)
    if ($shortcut.TargetPath -eq $launcher -and $shortcut.Arguments -eq 'launch') { Remove-Item $legacyShortcut }
  }
  Write-Host "Installed into your existing T3 Code app. Reopen it using its normal icon."
  Write-Host "Find Mods in the sidebar or Settings → Mods. Individual mod changes apply live."
  Write-Host "Tool command: $launcher"
} finally { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
