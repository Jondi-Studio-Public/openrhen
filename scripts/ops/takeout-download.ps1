<#
.SYNOPSIS
  Downloads the zip parts of a finished Google Takeout without clicking each one.

.DESCRIPTION
  Google offers no download API for Takeout, and the download links need your signed-in browser
  session. So you copy ONE real download request from your browser, and this script replays it
  for every part, changing only the part number ("i=" in the address).

  1. Open the Takeout archive page and sign in.
  2. Open DevTools (F12), then the Network tab.
  3. Click Download on any one zip. Google may ask you to sign in again: do.
  4. In the Network tab find the request whose address starts with
     https://takeout.google.com/takeout/download?  (it may redirect, take the first one).
  5. Right-click it, Copy, "Copy as cURL (bash)". Paste into a text file OUTSIDE this repository,
     for example C:\Users\you\Documents\data-exports\request.txt. It holds your login cookies:
     delete it when the downloads finish.
  6. Run this script:

       .\scripts\ops\takeout-download.ps1 -RequestFile C:\Users\you\Documents\data-exports\request.txt `
         -OutDir C:\Users\you\Documents\data-exports\takeout -From 0 -To 35

  Part numbers start at 0 and follow the order of the files on the archive page. The script prints
  which file name each number gave, so you can see what -Only should hold to fetch a subset.

  A full export has dozens of parts and the cookies last about an hour, so expect to refresh the
  request file part-way through: when a part fails, copy a fresh request over the same file and
  run the same command again. Finished parts are skipped and a half-downloaded part carries on
  from the byte it reached (it is kept as partN.part until it is complete and its size checked).

  The cookies are passed to curl through a private temporary file that only you can read and that
  is deleted when the script ends, so they never appear on the command line or in the process list.

  Nothing here uses Google's private APIs or automates the login. It repeats the request your
  browser made, for files you are entitled to download.

.PARAMETER RequestFile
  Text file holding the "Copy as cURL (bash)" request. Refused if it sits inside a git working tree.
.PARAMETER OutDir
  Folder the zips are saved into. Created if missing.
.PARAMETER From
  First part number. Default 0.
.PARAMETER To
  Last part number, inclusive. Required unless -Only is given.
.PARAMETER Only
  A list of part numbers to fetch instead of the From..To range, for example -Only 3,7,12.
.PARAMETER MinFreeGB
  Fail before starting when the drive of OutDir has less free space than this. Default 120, which
  suits a full run; lower it when fetching a few small parts.
.PARAMETER PartReserveGB
  Before each part, fail when free space is below this. Default 6, a little over one part.
.PARAMETER DryRun
  Prints what would be fetched and downloads nothing.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$From = 0,
  [int]$To = -1,
  [int[]]$Only,
  [double]$MinFreeGB = 120,
  [double]$PartReserveGB = 6,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $Only -and $To -lt $From) {
  throw 'Give -To (the last part number, for example -To 35), or -Only with the part numbers to fetch. Without one of them nothing would be fetched.'
}

# ---- curl: present and new enough for --output-dir / --config -----------------------------------
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) { throw 'curl.exe was not found. It ships with Windows 10 and later; check your PATH.' }
$curlVersionLine = (& $curl.Source --version | Select-Object -First 1)
if ($curlVersionLine -match 'curl (\d+)\.(\d+)') {
  $curlMajor = [int]$Matches[1]; $curlMinor = [int]$Matches[2]
  if ($curlMajor -lt 7 -or ($curlMajor -eq 7 -and $curlMinor -lt 73)) {
    throw "curl.exe is too old ($curlVersionLine). Version 7.73 or later is needed; update Windows or install a newer curl."
  }
}

# ---- the request file must not live where it could be committed ---------------------------------
$requestFull = (Resolve-Path -LiteralPath $RequestFile).Path
$probe = Split-Path -Parent $requestFull
while ($probe) {
  if (Test-Path -LiteralPath (Join-Path $probe '.git')) {
    throw "The request file holds live login cookies and sits inside a git working tree ($probe). Move it somewhere outside any repository."
  }
  $parent = Split-Path -Parent $probe
  if ($parent -eq $probe) { break }
  $probe = $parent
}

# ---- parse the copied request -------------------------------------------------------------------
function ConvertFrom-ShellQuoted([string]$token) {
  if ($token.StartsWith("$'")) {
    # bash ANSI-C quoting: \' \\ \n \r \t and \xHH \uHHHH
    $inner = $token.Substring(2, $token.Length - 3)
    $inner = [regex]::Replace($inner, '\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|.)', {
      param($m)
      $e = $m.Groups[1].Value
      switch -Regex ($e) {
        '^n$' { "`n" }
        '^r$' { "`r" }
        '^t$' { "`t" }
        '^x'  { [string][char][Convert]::ToInt32($e.Substring(1), 16) }
        '^u'  { [string][char][Convert]::ToInt32($e.Substring(1), 16) }
        default { $e }
      }
    })
    return $inner
  }
  return $token.Substring(1, $token.Length - 2)
}

$requestText = Get-Content -Raw -LiteralPath $requestFull -Encoding UTF8
$urlMatch = [regex]::Match($requestText, "https://takeout\.google\.com/takeout/download\?[^'`" \r\n^\\]+")
if (-not $urlMatch.Success) {
  throw 'No Takeout download address found in the request file. Copy a request whose address starts with https://takeout.google.com/takeout/download?'
}
$baseUrl = $urlMatch.Value
if ($baseUrl -notmatch '[?&]i=\d+') {
  throw 'The address has no i= part number. Copy the request from a part download, not the archive page.'
}

$quoted = '(\$?''(?:[^''\\]|\\.)*'')'
$headerList = New-Object System.Collections.Generic.List[string]
foreach ($m in [regex]::Matches($requestText, "(?:^|\s)(?:-H|--header)\s+$quoted")) {
  $h = ConvertFrom-ShellQuoted $m.Groups[1].Value
  # curl sets these itself; replaying them breaks range and encoding handling.
  if ($h -match '^(?i)(range|accept-encoding|content-length|host|if-range):') { continue }
  $headerList.Add($h)
}
$cookieValue = $null
$cm = [regex]::Match($requestText, "(?:^|\s)(?:-b|--cookie)\s+$quoted")
if ($cm.Success) { $cookieValue = ConvertFrom-ShellQuoted $cm.Groups[1].Value }
$cookieInHeader = $headerList | Where-Object { $_ -match '^(?i)cookie:\s*\S' }
if ($headerList.Count -eq 0) {
  throw 'No headers could be read from the request file. Copy it again as "Copy as cURL (bash)".'
}
if ([string]::IsNullOrWhiteSpace($cookieValue) -and -not $cookieInHeader) {
  throw 'No cookies could be read from the request file. Copy it as "cURL (bash)" from a signed-in browser.'
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$partList = if ($Only) { $Only } else { $From..$To }
$logPath = Join-Path $OutDir 'download-log.txt'

function Get-PartUrl([int]$n) { return [regex]::Replace($baseUrl, '([?&]i=)\d+', "`${1}$n") }
function Get-FreeBytes([string]$dir) {
  $root = [System.IO.Path]::GetPathRoot($dir)
  return ([System.IO.DriveInfo]::new($root)).AvailableFreeSpace
}
function ConvertTo-CurlConfigString([string]$s) {
  return '"' + ($s -replace '\\', '\\' -replace '"', '\"' -replace "`r", '\r' -replace "`n", '\n' -replace "`t", '\t') + '"'
}

$freeGB = (Get-FreeBytes $OutDir) / 1GB
if (-not $DryRun -and $freeGB -lt $MinFreeGB) {
  throw ('Only {0:N0} GB free on the drive of {1}; need {2:N0} GB. Free some space, or lower -MinFreeGB if you are fetching only a few parts.' -f $freeGB, $OutDir, $MinFreeGB)
}

$doneParts = @{}
if (Test-Path -LiteralPath $logPath) {
  foreach ($line in Get-Content -LiteralPath $logPath -Encoding ASCII) {
    $f = $line -split "`t"
    if ($f.Count -ge 3) { $doneParts[[int]$f[0]] = $f[1] }
  }
}

# ---- private curl config: cookies and headers never touch the command line ----------------------
function New-PrivateFile {
  $path = Join-Path ([System.IO.Path]::GetTempPath()) ('takeout-' + [guid]::NewGuid().ToString('N') + '.cfg')
  New-Item -ItemType File -Path $path | Out-Null
  $acl = Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $path -AclObject $acl
  return $path
}

$failed = New-Object System.Collections.Generic.List[int]
$fetched = 0
[int64]$totalBytes = 0
$configPath = $null
try {
  foreach ($n in $partList) {
    if ($doneParts.ContainsKey($n) -and (Test-Path -LiteralPath (Join-Path $OutDir $doneParts[$n]))) {
      Write-Host ("part {0}: already have {1}, skipping" -f $n, $doneParts[$n]); continue
    }
    $url = Get-PartUrl $n
    if ($DryRun) { Write-Host ("part {0}: would fetch {1}" -f $n, ($url -replace '(j=)[^&]+', '$1...')); continue }

    $freeNow = (Get-FreeBytes $OutDir) / 1GB
    if ($freeNow -lt $PartReserveGB) {
      throw ('Only {0:N1} GB free before part {1}; need {2:N1} GB. Free some space and run again: finished parts are kept.' -f $freeNow, $n, $PartReserveGB)
    }

    $partFile = Join-Path $OutDir ("part{0}.part" -f $n)
    $headerDump = Join-Path $OutDir ("part{0}.headers" -f $n)
    if (-not $configPath) { $configPath = New-PrivateFile }
    $cfg = New-Object System.Collections.Generic.List[string]
    foreach ($h in $headerList) { $cfg.Add('header = ' + (ConvertTo-CurlConfigString $h)) }
    if ($cookieValue) { $cfg.Add('cookie = ' + (ConvertTo-CurlConfigString $cookieValue)) }
    $cfg.Add('url = ' + (ConvertTo-CurlConfigString $url))
    [System.IO.File]::WriteAllLines($configPath, $cfg, (New-Object System.Text.UTF8Encoding($false)))

    $resumeNote = ''
    if (Test-Path -LiteralPath $partFile) { $resumeNote = ' (resuming at {0:N0} MB)' -f ((Get-Item -LiteralPath $partFile).Length / 1MB) }
    Write-Host ("part {0}: downloading{1}..." -f $n, $resumeNote)

    $curlArgs = @('--config', $configPath, '--fail', '--location', '--silent', '--show-error',
      '--retry', '3', '--retry-delay', '5', '--continue-at', '-',
      '--dump-header', $headerDump, '--output', $partFile,
      '--write-out', '%{http_code}|%{content_type}|%{size_download}')
    $writeOut = & $curl.Source @curlArgs
    $exit = $LASTEXITCODE
    if ($exit -eq 33 -and (Test-Path -LiteralPath $partFile)) {
      # The server would not resume: start this part again from the beginning, once.
      Remove-Item -LiteralPath $partFile -Force
      $writeOut = & $curl.Source @curlArgs
      $exit = $LASTEXITCODE
    }
    if ($exit -ne 0) {
      Write-Warning ("part {0} failed (curl exit {1}). The cookies may have expired: copy a fresh request into the request file and run the same command again; the part resumes." -f $n, $exit)
      $failed.Add($n); continue
    }

    $wo = ($writeOut | Select-Object -Last 1) -split '\|'
    $contentType = if ($wo.Count -ge 2) { $wo[1] } else { '' }
    if ($contentType -match '(?i)text/html') {
      Remove-Item -LiteralPath $partFile -Force -ErrorAction SilentlyContinue
      Write-Warning ("part {0} came back as a web page (probably a sign-in page) and was deleted. Copy a fresh request and run again." -f $n)
      $failed.Add($n); continue
    }

    # Read the LAST response in the header dump (earlier blocks are redirects).
    $dump = Get-Content -Raw -LiteralPath $headerDump -Encoding ASCII
    $blocks = @($dump -split '(?:\r?\n){2,}' | Where-Object { $_.Trim() })
    $last = if ($blocks.Count -gt 0) { $blocks[$blocks.Count - 1] } else { '' }
    $expected = $null
    $rangeMatch = [regex]::Match($last, '(?im)^content-range:\s*bytes\s+\d+-\d+/(\d+)')
    if ($rangeMatch.Success) { $expected = [int64]$rangeMatch.Groups[1].Value }
    else {
      $lenMatch = [regex]::Match($last, '(?im)^content-length:\s*(\d+)')
      if ($lenMatch.Success) { $expected = [int64]$lenMatch.Groups[1].Value }
    }
    $actual = (Get-Item -LiteralPath $partFile).Length
    if ($null -ne $expected -and $actual -ne $expected) {
      Write-Warning ("part {0} is {1} bytes but the server said {2}. It stays as part{0}.part; run again to continue it." -f $n, $actual, $expected)
      $failed.Add($n); continue
    }

    $name = "takeout-part-$n.zip"
    $nameMatch = [regex]::Match($last, '(?im)^content-disposition:.*?filename\*?=(?:UTF-8'''')?"?([^";\r\n]+)')
    if ($nameMatch.Success) { $name = [System.IO.Path]::GetFileName([System.Uri]::UnescapeDataString($nameMatch.Groups[1].Value.Trim())) }
    $finalPath = Join-Path $OutDir $name
    Move-Item -LiteralPath $partFile -Destination $finalPath -Force
    Remove-Item -LiteralPath $headerDump -Force -ErrorAction SilentlyContinue

    Add-Content -LiteralPath $logPath -Value ("{0}`t{1}`t{2}" -f $n, $name, $actual) -Encoding ASCII
    $fetched++
    $totalBytes += $actual
    Write-Host ("part {0}: {1} ({2:N1} MB)" -f $n, $name, ($actual / 1MB))
  }
}
finally {
  if ($configPath -and (Test-Path -LiteralPath $configPath)) { Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host ('Fetched {0} part(s), {1:N2} GB.' -f $fetched, ($totalBytes / 1GB))
if ($failed.Count -gt 0) {
  Write-Host ('Failed parts: ' + ($failed -join ',') + '. Refresh the request file if the cookies expired, then run the same command again.')
  exit 1
}
Write-Host "Name map: $logPath"
