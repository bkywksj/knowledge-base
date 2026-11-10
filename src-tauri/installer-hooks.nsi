; ============================================================================
; 自定义 NSIS 安装钩子
; ① 升级时给 kb-mcp.exe 改名让位：它常被外部 MCP host 通过 stdio 占着，直接覆盖会写不进去。
;    用下面的标准宏 SIDECAR_ASIDE，各应用同一份，标准写法见 Reeve 的 tauri-packaging 技能。
; ② 保留 productName="Knowledge Base"（让 CI 产物名/updater URL 全英文，
;    避免 GitHub Release Asset 中文字符 URL 编码导致更新失败），
;    同时让用户桌面/开始菜单的快捷方式显示中文"知识库"。
;
; 编码必须为 UTF-8 with BOM，否则 NSIS 编译器无法正确识别中文字面量。
; ============================================================================

; ---------------------------------------------------------------------------
; [installer-std] sidecar-aside v1
; External MCP hosts (Claude Code, Codex, Cursor...) launch the sidecar over
; stdio from $INSTDIR, so during an upgrade its exe is usually locked and
; writing the new file fails half way through the install. Windows will not
; overwrite or delete a running exe, but it does allow renaming it: move the
; old file to <exe>.old, the running process keeps using it and AI sessions
; stay connected, and the new file goes to the original path.
; Killing is not enough: a host can relaunch the old exe before NSIS gets to
; that file, and Claude Code does not reconnect on its own.
; .old to .old5 cover several upgrades without restarting the AI client;
; taskkill is the last resort when all five names are still in use.
; Usage:
;   PREINSTALL     !insertmacro SIDECAR_ASIDE "foo-mcp.exe" "foo_mcp"
;   POSTINSTALL    Delete "$INSTDIR\foo-mcp.exe.old*"
;   POSTUNINSTALL  Delete "$INSTDIR\foo-mcp.exe.old*" then RMDir "$INSTDIR"
; ---------------------------------------------------------------------------
!macro SIDECAR_ASIDE EXE UNIQ
  Push $R8
  Push $R9
  ; leftovers from earlier upgrades, deletable once their process has exited
  Delete "$INSTDIR\${EXE}.old*"
  ClearErrors
  IfFileExists "$INSTDIR\${EXE}" 0 sidecar_aside_done_${UNIQ}
  StrCpy $R8 ""
  StrCpy $R9 1
  sidecar_aside_try_${UNIQ}:
    ClearErrors
    Rename "$INSTDIR\${EXE}" "$INSTDIR\${EXE}.old$R8"
    IfErrors 0 sidecar_aside_done_${UNIQ}
    IntOp $R9 $R9 + 1
    StrCpy $R8 $R9
    IntCmp $R9 5 sidecar_aside_try_${UNIQ} sidecar_aside_try_${UNIQ} sidecar_aside_kill_${UNIQ}
  sidecar_aside_kill_${UNIQ}:
    ; all five names taken: kill every instance (AI sessions drop), retry once
    nsExec::Exec 'taskkill /F /IM ${EXE}'
    Pop $R8
    Sleep 800
    Delete "$INSTDIR\${EXE}.old*"
    ClearErrors
    Rename "$INSTDIR\${EXE}" "$INSTDIR\${EXE}.old"
    ClearErrors
  sidecar_aside_done_${UNIQ}:
  Pop $R9
  Pop $R8
!macroend
; ---------------------------------------------------------------------------

!macro NSIS_HOOK_PREINSTALL
  ; 以前这里是 taskkill：杀掉后外部客户端可能在安装器写到 kb-mcp.exe 之前又把旧 exe
  ; 拉起来，照样写不进去；而且 Claude Code 不会自动重连。改名让位都不会。
  !insertmacro SIDECAR_ASIDE "kb-mcp.exe" "kb_mcp"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 删除 Tauri 默认创建的英文快捷方式
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"

  ; 创建中文快捷方式（指向同一个 exe）
  CreateShortcut "$DESKTOP\知识库.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\知识库.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; 覆盖 Tauri fileAssociations 默认生成的右键菜单文字
  ; Tauri 默认写入 "Open with ${PRODUCTNAME}"（=Open with Knowledge Base），
  ; 这里改为中文"使用知识库打开"。FILECLASS 取自 tauri.conf.json 的 name 字段。
  WriteRegStr SHCTX "Software\Classes\Markdown 文件\shell\open" "" "使用知识库打开"

  ; 让位下来的旧 sidecar：对应进程已退出就删掉，还在跑就留给下次安装或卸载
  Delete "$INSTDIR\kb-mcp.exe.old*"
  ClearErrors
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时清理中文快捷方式
  Delete "$DESKTOP\知识库.lnk"
  Delete "$SMPROGRAMS\$AppStartMenuFolder\知识库.lnk"

  ; 卸载不杀 sidecar：被占的 kb-mcp.exe 留在原地，下次安装让位时清掉。
  ; 删完让位残留再删一次目录（模板的 RMDir 在本钩子之前，那时 .old 还在，目录删不掉）
  Delete "$INSTDIR\kb-mcp.exe.old*"
  ClearErrors
  RMDir "$INSTDIR"
  ClearErrors
!macroend