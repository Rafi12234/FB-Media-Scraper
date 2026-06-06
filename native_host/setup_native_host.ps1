param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$HostName = "com.fb_media_scraper.device_check"
$HostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourcePath = Join-Path $HostDir "device_check_host.cs"
$ExePath = Join-Path $HostDir "device_check_host.exe"
$JsonPath = Join-Path $HostDir "$HostName.json"

if (-not (Test-Path $SourcePath)) {
  throw "device_check_host.cs not found at $SourcePath"
}

Write-Host "Compiling native host..."
Add-Type -TypeDefinition (Get-Content $SourcePath -Raw) -OutputAssembly $ExePath -OutputType ConsoleApplication

if (-not (Test-Path $ExePath)) {
  throw "Failed to create native host executable at $ExePath"
}

$NativeHost = [ordered]@{
  name = $HostName
  description = "Device MAC checker for FB Media Scraper"
  path = $ExePath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$NativeHost | ConvertTo-Json -Depth 5 | Set-Content -Path $JsonPath -Encoding ASCII

$RegistrySubKey = "Software\Google\Chrome\NativeMessagingHosts\$HostName"
$RegistryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrySubKey)
$RegistryKey.SetValue("", $JsonPath, [Microsoft.Win32.RegistryValueKind]::String)
$RegistryKey.Close()

Write-Host "Native host registered successfully."
Write-Host "Host EXE: $ExePath"
Write-Host "Host JSON: $JsonPath"
Write-Host "Allowed extension: chrome-extension://$ExtensionId/"
Write-Host "Now reload the extension from chrome://extensions/."
