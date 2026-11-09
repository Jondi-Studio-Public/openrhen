# Install rhen-watch @VERSION@ for this user: download the release zip, check its SHA-256 against the
# release's SHA256SUMS, unpack to a temporary folder, run `rhen-watch.exe install`, delete the temporary folder.
#
# No administrator rights. Touches nothing outside that temporary folder and rhen-watch's own per-user
# install (%LOCALAPPDATA%\Programs\rhen-watch, a start-at-logon entry for your user, and its data folder).
# The program is not code-signed, so Windows SmartScreen may warn about a copy you download in a browser.
# Works in Windows PowerShell 5.1 and PowerShell 7. Run again to upgrade.
function Install-RhenWatch {
  $version = '@VERSION@'
  $base = "https://github.com/Jondi-Studio-Public/openrhen/releases/download/rhen-watch-v$version"
  $asset = "rhen-watch-$version-windows-x86_64.zip"

  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Stop'
  $tmp = $null
  try {
    if ($version -notmatch '^\d+\.\d+\.\d+') { throw "this script was not stamped with a version (got '$version'); use the install.ps1 attached to a release" }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'rhen-watch install.ps1 is for Windows' }
    # Windows PowerShell 5.1 may default to protocols GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('rhen-watch-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'SHA256SUMS'

    Write-Host "Downloading rhen-watch $version ..."
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

    # sha256sum format: "<hash>  <name>" (a "*" before the name marks binary mode).
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sums) {
      if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $asset) { $expected = $Matches[1]; break }
    }
    if (-not $expected) { throw "SHA256SUMS has no line for $asset" }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) { throw "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed" }
    Write-Host 'Checksum verified.'

    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $exe = Join-Path $unpacked 'rhen-watch.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw 'rhen-watch.exe is missing from the zip' }

    & $exe install
    if ($LASTEXITCODE -ne 0) { throw "rhen-watch install failed (exit $LASTEXITCODE)" }

    $dest = Join-Path $env:LOCALAPPDATA 'Programs\rhen-watch'
    Write-Host ''
    Write-Host "Installed rhen-watch $version to $dest"
    Write-Host "Stop it:      & '$dest\rhen-watch.exe' stop"
    Write-Host "Uninstall:    & '$dest\rhen-watch.exe' uninstall      (add --purge to delete your data too)"
    Write-Host 'Note: this build is unsigned, so SmartScreen may warn about a copy downloaded in a browser.'
  }
  finally {
    $ErrorActionPreference = 'Continue'
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    $ErrorActionPreference = $previous
  }
}
Install-RhenWatch
