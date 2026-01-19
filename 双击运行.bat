@echo off
chcp 65001 >nul
title 抽奖系统（发布版 · 双服务并行）

set "ROOT_DIR=%~dp0"
set "NODE_HOME=%ROOT_DIR%node-v20.20.0-win-x64"
set "NODE_EXE=%NODE_HOME%\node.exe"
set "NPM_JS=%NODE_HOME%\node_modules\npm\bin\npm-cli.js"
set "PATH=%NODE_HOME%;%PATH%"

echo ========================================
echo   抽奖系统 启动中
echo ----------------------------------------
"%NODE_EXE%" -v
echo ========================================
echo.

REM 校验 concurrently
"%NODE_EXE%" "%NPM_JS%" list concurrently >nul 2>&1
if errorlevel 1 (
    echo [初始化] 安装 concurrently...
    "%NODE_EXE%" "%NPM_JS%" install -D concurrently
    echo.
)

REM 原生模块检查
if not exist "%ROOT_DIR%node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
    echo [初始化] 编译 better-sqlite3...
    "%NODE_EXE%" "%NPM_JS%" rebuild better-sqlite3
    echo.
)

echo [启动] 前端 + 后端（使用 concurrently）
echo ----------------------------------------
echo   关闭窗口即可停止所有服务
echo ----------------------------------------
echo.

REM --- 关键修改：去掉了 --workspaces ---
REM 这样才会执行根目录 package.json 中定义的 "concurrently ..." 命令
call "%NODE_EXE%" "%NPM_JS%" run dev

echo.
echo ========================================
echo   服务已退出（npm dev 结束）
echo ========================================
pause