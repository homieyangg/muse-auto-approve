# 下載 Auto Approve for Muse 到固定資料夾並打開 chrome://extensions；Chrome 不允許程式直接裝插件，最後一步要使用者自己按「載入未封裝項目」
# 包在 script block 裡，irm | iex 執行時變數和 ErrorActionPreference 才不會留在使用者的 session
& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'homieyangg/muse-auto-approve'
  $ZipUrl = if ($env:MUSE_AA_ZIP_URL) { $env:MUSE_AA_ZIP_URL } else { "https://github.com/$Repo/releases/latest/download/muse-auto-approve.zip" }
  $Dest = if ($env:MUSE_AA_DIR) { $env:MUSE_AA_DIR } else { Join-Path $HOME 'muse-auto-approve' }
  $Manifest = Join-Path $Dest 'manifest.json'

  $IsUpdate = $false
  if (Test-Path $Dest) {
    $NameFiles = @($Manifest, (Join-Path $Dest '_locales/en/messages.json')) | Where-Object { Test-Path $_ }
    if (-not ($NameFiles -and (Select-String -Path $NameFiles -SimpleMatch '"Auto Approve for Muse"' -Quiet))) {
      throw "$Dest already exists and isn't this extension. Remove it or set MUSE_AA_DIR to another folder."
    }
    $IsUpdate = $true
  }

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("muse-aa-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  try {
    $Zip = Join-Path $Tmp 'ext.zip'
    $Unpacked = Join-Path $Tmp 'ext'
    Invoke-WebRequest -Uri $ZipUrl -OutFile $Zip -UseBasicParsing
    Expand-Archive -Path $Zip -DestinationPath $Unpacked
    if (-not (Test-Path (Join-Path $Unpacked 'manifest.json'))) { throw 'The downloaded archive has no manifest.json' }
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    Copy-Item -Recurse -Path $Unpacked -Destination $Dest
  } finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }

  $Version = (Get-Content $Manifest -Raw | ConvertFrom-Json).version

  if ($IsUpdate) {
    Write-Host "Updated Auto Approve for Muse to $Version in $Dest"
    Write-Host 'Open chrome://extensions and click the reload icon on its card, or restart Chrome.'
    return
  }

  Write-Host "Downloaded Auto Approve for Muse $Version to $Dest`n"
  $Copied = $false
  try { Set-Clipboard -Value $Dest; $Copied = $true } catch { }
  try { Start-Process 'chrome' 'chrome://extensions' } catch { Write-Host 'Open chrome://extensions in Chrome.' }

  Write-Host 'Finish in Chrome:'
  Write-Host '  1. Turn on "Developer mode" in the top right corner.'
  Write-Host '  2. Click "Load unpacked" and choose this folder:'
  Write-Host "       $Dest"
  if ($Copied) { Write-Host '     The path is on your clipboard. Paste it into the folder box at the bottom of the picker and confirm.' }
  Write-Host "  3. Reload any open muse.ai tabs.`n"
  Write-Host 'Run the same command again later to update.'
}
