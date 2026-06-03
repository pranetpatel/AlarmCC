# Start ngrok tunnel to local AlarmCC server (port 3000)
$repoNgrok = Join-Path $PSScriptRoot "..\tools\ngrok\ngrok.exe"
$wingetNgrok = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"

if (Test-Path $repoNgrok) { $ngrok = $repoNgrok }
elseif (Test-Path $wingetNgrok) { $ngrok = $wingetNgrok }
else {
  Write-Error "ngrok not found. Run from repo root or: winget install ngrok.ngrok"
  exit 1
}

Write-Host "Using: $ngrok"
& $ngrok http 3000
