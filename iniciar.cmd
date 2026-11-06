@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Escritorio IA
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   O Node.js nao esta instalado.
  echo   Baixe a versao LTS em https://nodejs.org , instale e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo   O Node.js instalado e antigo. Instale a versao LTS mais nova em https://nodejs.org
  echo.
  pause
  exit /b 1
)

node -e "try{process.exit(require('./config.json').owner?0:1)}catch{process.exit(1)}"
if not errorlevel 1 goto rodar
echo.
set "NOME="
set /p NOME="  Seu nome no escritorio: "
node -e "const fs=require('fs');let c={port:4480,showText:true,peers:[]};try{c=JSON.parse(fs.readFileSync('config.json','utf8'))}catch{};c.owner=(process.argv[1]||'').trim()||require('os').userInfo().username;fs.writeFileSync('config.json',JSON.stringify(c,null,2))" "%NOME%"

:rodar
echo.
echo   Deixe esta janela aberta enquanto quiser aparecer no escritorio.
echo   Se o Windows ou o antivirus perguntar sobre o firewall, clique em PERMITIR.
echo.
set "ESCRITORIO_SUPERVISOR=1"
:loop
node --no-warnings server.mjs
rem codigo 42 = acabou de baixar uma versao nova, abre de novo
if %errorlevel%==42 goto loop
pause
