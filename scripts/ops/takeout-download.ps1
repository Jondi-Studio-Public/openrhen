<#
.SYNOPSIS
  Downloads the zip parts of a finished Google Takeout export without clicking each one.

.DESCRIPTION
  Google offers no download API for Takeout, and the download links need your signed-in browser
  session. So you copy ONE real download request from your browser, and this script replays it
  for every part, changing only the part number ("i=" in the address).

  1. Open the Takeout archive page and sign in.
  2. Open DevTools (F12), then the Network tab.
  3. Click Download on any one zip. Google may ask you to sign in again: do.
  4. In the Network tab find the request whose address starts with
     https://takeout.google.com/takeout/download?  (it may redirect, take the first one).
  5. Right-click it, Copy, "Copy as cURL (bash)". Paste into a text file, for example
     C:\Users\you\Documents\data-exports\request.txt, and keep that file private: it holds your
     login cookies. Delete it when the downloads finish.
  6. Run this script:

       .\scripts\ops\takeout-download.ps1 -RequestFile C:\Users\you\Documents\data-exports\request.txt `
         -OutDir C:\Users\you\Documents\data-exports\takeout -From 0 -To 35

  Part numbers start at 0 and follow the order of the files on the archive page. The script prints
  which file name each number gave, so you can see what -Only should hold to fetch a subset.

  Cookies expire after about an hour of use. If a download comes back as a web page or the script
  reports a failure, copy a fresh request and run it again with -Only for the numbers that failed;
  finished files are not fetched twice.

  Nothing here uses Google's private APIs or automates the login. It repeats the request your
  browser made, for files you are entitled to download.

.PARAMETER RequestFile
  Text file holding the "Copy as cURL (bash)" request.
.PARAMETER OutDir
  Folder the zips are saved into. Created if missing.
.PARAMETER From
  First part number. Default 0.
.PARAMETER To
  Last part number, inclusive.
.PARAMETER Only
  A list of part numbers to fetch instead of the From..To range, for example -Only 3,7,12.
.PARAMETER DryRun
  Prints what would be fetched and the file names found so far, and downloads nothing.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$From = 0,
  [int]$To = 0,
  [int[]]$Only,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) { throw 'curl.exe was not found. It ships with Windows 10 and later; check your PATH.' }

$text = Get-Content -Raw -LiteralPath $RequestFile
$urlMatch = [regex]::Match($text, "https://takeout\.google\.com/takeout/download\?[^'`" \r\n^]+")
if (-not $urlMatch.Success) {
  throw 'No Takeout download address found in the request file. Copy a request whose address starts with https://takeout.google.com/takeout/download?'
}
$baseUrl = $urlMatch.Value
if ($baseUrl -notmatch '[?&]i=\d+') {
  throw 'The address has no i= part number. Copy the request from a part download, not the archive page.'
}

# Pull the headers and cookie string out of the bash-style request. Single-quoted arguments only,
# so nothing is ever run through a shell.
$headers = New-Object System.Collections.Generic.List[string]
foreach ($m in [regex]::Matches($text, "(?:-H|--header)\s+'([^']*)'")) {
  $h = $m.Groups[1].Value
  # curl sets these itself; replaying them breaks range and encoding handling.
  if ($h -match '^(?i)(range|accept-encoding|content-length|host):') { continue }
  $headers.Add($h)
}
$cookie = $null
$cm = [regex]::Match($text, "(?:-b|--cookie)\s+'([^']*)'")
if ($cm.Success) { $cookie = $cm.Groups[1].Value }
if (-not $cookie -and -not ($headers | Where-Object { $_ -match '^(?i)cookie:' })) {
  throw 'No cookies in the request file. Copy it as "cURL (bash)" from a signed-in browser.'
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$parts = if ($Only) { $Only } else { $From..$To }
$log = Join-Path $OutDir 'download-log.txt'

function Get-PartUrl([int]$i) { return [regex]::Replace($baseUrl, '([?&]i=)\d+', "`${1}$i") }

$failed = New-Object System.Collections.Generic.List[int]
$done = @{}
if (Test-Path -LiteralPath $log) {
  foreach ($l in Get-Content -LiteralPath $log) { $f = $l -split "`t"; if ($f.Count -ge 3) { $done[[int]$f[0]] = $f[1] } }
}
foreach ($i in $parts) {
  if ($done.ContainsKey($i) -and (Test-Path -LiteralPath (Join-Path $OutDir $done[$i]))) {
    Write-Host ("part {0}: already have {1}, skipping" -f $i, $done[$i]); continue
  }
  $url = Get-PartUrl $i
  if ($DryRun) { Write-Host ("part {0}: would fetch {1}" -f $i, ($url -replace '(j=)[^&]+', '$1...')); continue }

  $args = @('--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-delay', '5',
    '--remote-name', '--remote-header-name', '--output-dir', $OutDir, '--write-out', '%{filename_effective}|%{http_code}|%{size_download}')
  foreach ($h in $headers) { $args += @('-H', $h) }
  if ($cookie) { $args += @('-b', $cookie) }
  $args += $url

  Write-Host ("part {0}: downloading..." -f $i)
  $out = & $curl.Source @args
  if ($LASTEXITCODE -ne 0) {
    Write-Warning ("part {0} failed (curl exit {1}). Cookies may have expired: copy a fresh request and rerun with -Only {0}." -f $i, $LASTEXITCODE)
    $failed.Add($i)
    continue
  }
  $parts2 = ($out -split '\|')
  $name = Split-Path -Leaf $parts2[0]
  $size = [int64]$parts2[2]
  if ($size -lt 1MB -and $name -notmatch '\.(zip|mov|mp4)$') {
    Write-Warning ("part {0} saved as {1} ({2} bytes) which does not look like an export file. It is probably a sign-in page: copy a fresh request." -f $i, $name, $size)
    $failed.Add($i)
    continue
  }
  $line = "{0}`t{1}`t{2}" -f $i, $name, $size
  Add-Content -LiteralPath $log -Value $line
  Write-Host ("part {0}: {1} ({2:N1} MB)" -f $i, $name, ($size / 1MB))
}

if ($failed.Count -gt 0) {
  Write-Host ''
  Write-Host ('Failed parts: ' + ($failed -join ',') + '. Rerun with -Only ' + ($failed -join ','))
  exit 1
}
Write-Host ''
Write-Host "Done. Name map: $log"
