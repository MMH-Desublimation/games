<#
.SYNOPSIS
    一键上传 GitHub Release 与三个发行资产（Web zip / Windows zip / Android APK）。

.DESCRIPTION
    为什么需要 Token：GitHub Releases 与资产上传**只能通过 Web 界面或 REST API** 完成，
    不能用 git push。而命令行无法从 Git Credential Manager 导出凭据（实测被拒），
    所以这里显式要求一个 Personal Access Token。

    需要的权限（二选一）：
      - 经典 Token：勾选 `repo`（公开仓库也可用 `public_repo`）
      - 细粒度 Token：Repository access 选 **仅该仓库**，权限 **Contents: Read and write**

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/release_upload.ps1 -Token ghp_xxxxxxxxxxxx

.EXAMPLE
    # 不想把 Token 写在命令里（会进历史），可以只运行脚本，按提示输入
    powershell -ExecutionPolicy Bypass -File tools/release_upload.ps1
#>
param(
    [string]$Token = '',
    [string]$Owner = 'MMH-Desublimation',
    [string]$Repo  = 'games',
    [string]$Tag   = 'v1.0.0',
    [string]$AssetsDir = 'C:\Users\admin\Desktop\小游戏项目1\输出\releases'
)

$ErrorActionPreference = 'Stop'
# 用户的网络加速器会拦截证书链校验 ⇒ 显式放宽（仅本脚本进程内生效）
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

if (-not $Token) {
    $sec = Read-Host -Prompt '请粘贴 GitHub Token（输入时不显示）' -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $Token) { Write-Host '未提供 Token，退出。' -ForegroundColor Red; exit 1 }

$apiBase = "https://api.github.com/repos/$Owner/$Repo"
$headers = @{
    Authorization          = "token $Token"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'dungeon-survival-release-script'
    'X-GitHub-Api-Version' = '2022-11-28'
}

function Invoke-Gh([string]$Method, [string]$Url, $Body) {
    $params = @{ Method = $Method; Uri = $Url; Headers = $headers }
    if ($Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 6)
        $params.ContentType = 'application/json'
    }
    return Invoke-RestMethod @params
}

# —— 0) 校验 Token 与仓库 ——
Write-Host "[1/4] 校验 Token 与仓库 $Owner/$Repo ..." -ForegroundColor Cyan
try {
    $me = Invoke-Gh 'GET' 'https://api.github.com/user' $null
    Write-Host ("      登录身份：" + $me.login)
} catch {
    Write-Host "      Token 无效或无权限：$_" -ForegroundColor Red
    exit 1
}

# —— 1) 查 Release；无则创建 ——
Write-Host "[2/4] 查找 Release $Tag ..." -ForegroundColor Cyan
$release = $null
try {
    $release = Invoke-Gh 'GET' "$apiBase/releases/tags/$Tag" $null
    Write-Host ("      已存在：" + $release.html_url)
} catch {
    Write-Host '      不存在，创建中 ...'
    $body = @{
        tag_name         = $Tag
        name             = '地牢生存 v1.0.0'
        draft            = $false
        prerelease       = $false
        generate_release_notes = $true
    }
    $release = Invoke-Gh 'POST' "$apiBase/releases" $body
    Write-Host ("      已创建：" + $release.html_url)
}

# —— 2) 上传资产（同名先删旧，实现可重复执行）——
Write-Host '[3/4] 上传资产 ...' -ForegroundColor Cyan
$files = Get-ChildItem $AssetsDir -File | Sort-Object Name
if (-not $files) { Write-Host "      目录为空：$AssetsDir" -ForegroundColor Red; exit 1 }

foreach ($f in $files) {
    $existing = @()
    try { $existing = Invoke-Gh 'GET' "$apiBase/releases/$($release.id)/assets" $null } catch { }
    $dup = $existing | Where-Object { $_.name -eq $f.Name }
    if ($dup) {
        Invoke-Gh 'DELETE' "$apiBase/releases/assets/$($dup.id)" $null | Out-Null
        Write-Host ("      覆盖旧资产：" + $f.Name)
    }
    $uploadUrl = ($release.upload_url -replace '\{.*\}', '') + "?name=$([uri]::EscapeDataString($f.Name))"
    $mb = [math]::Round($f.Length / 1MB, 2)
    Write-Host ("      上传 " + $f.Name + "（" + $mb + " MB）...")
    $resp = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers `
        -ContentType 'application/octet-stream' -InFile $f.FullName
    Write-Host ("        ✓ " + $resp.browser_download_url) -ForegroundColor Green
}

# —— 3) 汇总 ——
Write-Host '[4/4] 完成。' -ForegroundColor Cyan
$final = Invoke-Gh 'GET' "$apiBase/releases/tags/$Tag" $null
Write-Host ("Release 页面：" + $final.html_url) -ForegroundColor Green
foreach ($a in $final.assets) {
    Write-Host ("  - " + $a.name + "  " + [math]::Round($a.size / 1MB, 2) + " MB  下载数 " + $a.download_count)
}
