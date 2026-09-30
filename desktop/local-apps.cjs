const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Only these built-in applications may be resolved and launched from the page.
const APPS = Object.freeze({
  wechat: { names: /微信|wechat|weixin/i, executables: ['WeChat.exe', 'Weixin.exe'] },
  qq: { names: /(^|\W)QQ(\W|$)|腾讯QQ/i, executables: ['QQ.exe'] },
  wps: { names: /WPS|金山文档|金山办公/i, executables: ['wps.exe', 'kdocs.exe'] },
  workbuddy: { names: /WorkBuddy/i, executables: ['WorkBuddy.exe'] }
});

function validExecutable(appId, value) {
  const app = APPS[appId];
  if (!app || typeof value !== 'string') return '';
  let candidate = value.trim().replace(/^"(.*)"(?:,\s*-?\d+)?$/, '$1').replace(/,\s*-?\d+$/, '');
  if (!path.isAbsolute(candidate) || !app.executables.some((name) => name.toLowerCase() === path.basename(candidate).toLowerCase())) return '';
  try {
    if (!fs.statSync(candidate).isFile()) return '';
    candidate = fs.realpathSync(candidate);
    return app.executables.some((name) => name.toLowerCase() === path.basename(candidate).toLowerCase()) ? candidate : '';
  } catch { return ''; }
}

function findInstalledApp(appId) {
  const app = APPS[appId];
  if (!app) throw new Error('不支持的本机应用');
  if (process.platform !== 'win32') return '';

  // Registry and Start Menu shortcuts cover per-user and machine-wide installs.
  // The PowerShell script contains only fixed allowlisted values, never page input.
  const names = app.executables.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const pattern = app.names.source.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$exeNames = @(${names})
$pattern = '${pattern}'
$found = New-Object System.Collections.Generic.List[string]
foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  foreach ($exe in $exeNames) {
    $key = Get-ItemProperty -LiteralPath (Join-Path $root $exe)
    if ($key) { $found.Add($key.'(default)') }
  }
}
foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  Get-ChildItem -LiteralPath $root | ForEach-Object {
    $item = Get-ItemProperty -LiteralPath $_.PSPath
    if ($item.DisplayName -match $pattern) {
      if ($item.DisplayIcon) { $found.Add([string]$item.DisplayIcon) }
      if ($item.InstallLocation) {
        foreach ($exe in $exeNames) { $found.Add((Join-Path $item.InstallLocation $exe)) }
      }
    }
  }
}
$shell = New-Object -ComObject WScript.Shell
foreach ($root in @([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'))) {
  if (-not $root) { continue }
  Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File | Where-Object { $_.BaseName -match $pattern } | ForEach-Object {
    $found.Add($shell.CreateShortcut($_.FullName).TargetPath)
  }
}
$found | ConvertTo-Json -Compress
`;
  let output;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
  } catch (error) {
    throw new Error('检测本机安装状态失败：' + error.message);
  }
  if (!output) return '';
  let candidates;
  try { candidates = JSON.parse(output); }
  catch { throw new Error('检测本机安装状态失败：系统返回的数据无效'); }
  for (const value of Array.isArray(candidates) ? candidates : [candidates]) {
    const executable = validExecutable(appId, value);
    if (executable) return executable;
  }
  return '';
}

module.exports = { APPS, validExecutable, findInstalledApp };
