@echo off
setlocal
set "ROOT=%~dp0.."
set "PATH=%ROOT%\toolchains\llvm-mingw-20260616-ucrt-x86_64\bin;%USERPROFILE%\.cargo\bin;%PATH%"
call %*
