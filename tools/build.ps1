<#
.SYNOPSIS
    地牢生存 · 一键构建脚本（Web / Android / Windows）。

.DESCRIPTION
    用 Cocos Creator 的命令行接口构建各平台产物。**不要**在 Cocos 编辑器打开本项目时运行
    Android / Windows 构建 —— 编辑器与 CLI 会争用 Asset DB，实测偶发
    `Error: Exit process with code:null, signal:SIGTERM in task build-script`
    （表现为耗时异常短 + 该错误行；此时需以**产物校验**为准，见文末）。

.EXAMPLE
    powershell -File tools/build.ps1 -Platform web-mobile
    powershell -File tools/build.ps1 -Platform android
    powershell -File tools/build.ps1 -Platform windows
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('web-mobile', 'android', 'windows')]
    [string]$Platform,

    [string]$Project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$Cocos = 'E:\Cocos Creator\Creator\3.8.7\CocosCreator.exe'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Cocos)) {
    Write-Host "[构建] 找不到 Cocos Creator: $Cocos" -ForegroundColor Red
    Write-Host "[构建] 请用 -Cocos 参数指定你的 CocosCreator.exe 路径。" -ForegroundColor Yellow
    exit 1
}

Write-Host "[构建] 平台 = $Platform" -ForegroundColor Cyan
Write-Host "[构建] 项目 = $Project" -ForegroundColor Cyan
Write-Host "[构建] 编辑器 = $Cocos" -ForegroundColor Cyan

$started = Get-Date
switch ($Platform) {
    'web-mobile' {
        # md5Cache=true ⇒ 产物文件名带 hash ⇒ 浏览器不会拿到旧缓存
        $buildArg = 'platform=web-mobile;debug=false;md5Cache=true'
    }
    'android' {
        # ⚠️ 不能写成 `platform=android;packageName=xxx` 的扁平形式 ——
        # 校验读的是 options.packages.android.packageName，扁平参数不会被映射进去，
        # 会报「packageName 必填项不允许为空」。必须走配置文件。
        #
        # ⚠️ 也不能用 `configPath=./build-android.json` 这种相对路径 ——
        # **实测报 `./build-android.json is not exist!`**（相对路径不以项目目录为基准）。
        # 必须传**绝对路径**（且用正斜杠）。
        $cfg = Join-Path $Project 'build-android.json'
        if (-not (Test-Path $cfg)) { Write-Host "[构建] 缺少 $cfg" -ForegroundColor Red; exit 1 }
        $buildArg = 'configPath=' + ($cfg -replace '\\', '/')
    }
    'windows' {
        $cfg = Join-Path $Project 'build-windows.json'
        if (-not (Test-Path $cfg)) { Write-Host "[构建] 缺少 $cfg" -ForegroundColor Red; exit 1 }
        $buildArg = 'configPath=' + ($cfg -replace '\\', '/')
    }
}

& $Cocos --project $Project --build $buildArg 2>&1 | Select-String -Pattern 'Finished|SIGTERM|Error:|失败|success' | Select-Object -Last 6
$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host "[构建] 耗时 ${elapsed}s" -ForegroundColor Cyan

# —— 产物校验（不轻信日志）——
$outDir = Join-Path $Project "build\$Platform"
if (-not (Test-Path $outDir)) {
    Write-Host "[构建] ✗ 未生成 $outDir —— 构建失败。" -ForegroundColor Red
    exit 1
}
$files = Get-ChildItem $outDir -Recurse -File
$mb = [math]::Round(($files | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "[构建] ✓ 产物：$($files.Count) 个文件 / $mb MB" -ForegroundColor Green

if ($Platform -eq 'android') {
    $apk = Get-ChildItem (Join-Path $outDir 'proj') -Recurse -Filter '*.apk' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($apk) {
        Write-Host "[构建] ✓ APK: $($apk.FullName)" -ForegroundColor Green
    } else {
        Write-Host "[构建] ⚠ 未找到 .apk —— 通常意味着 Android 工具链（JDK / SDK / NDK）未配置好，" -ForegroundColor Yellow
        Write-Host "        或编译中途失败。请在编辑器的「偏好设置 → 原生开发环境」中检查路径。" -ForegroundColor Yellow
    }
}
if ($Platform -eq 'windows') {
    $exe = Get-ChildItem (Join-Path $outDir 'proj') -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($exe) {
        Write-Host "[构建] ✓ 可执行文件: $($exe.FullName)" -ForegroundColor Green
    } else {
        Write-Host "[构建] ⚠ 未找到 .exe —— 通常意味着未安装 Visual Studio（MSVC 工具链）。" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "提示：若日志出现 SIGTERM 但产物文件数与体积正常，属编辑器争用导致的收尾中断，产物可用。" -ForegroundColor DarkGray
