@echo off
rem 在包目录内启动服务端：自动托管前端，默认 http://localhost:8080
cd /d "%~dp0"
if "%STATIC_DIR%"=="" set STATIC_DIR=apps/client/dist
if "%GAME_CONFIG%"=="" set GAME_CONFIG=config/game.toml
if "%SERVER_CONFIG%"=="" set SERVER_CONFIG=config/server.toml
if "%RUST_LOG%"=="" set RUST_LOG=info
server.exe %*
pause
