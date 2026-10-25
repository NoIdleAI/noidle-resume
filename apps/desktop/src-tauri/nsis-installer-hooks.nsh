; Tauri v2 NSIS 卸载钩子：卸载时询问是否连本机数据一起清掉。
; 数据目录与 shell/服务端约定同源：%APPDATA%\noidle-resume
; （lib.rs default_data_dir / config.ts defaultDataDir，三处同步改）。
!macro NSIS_HOOK_POSTUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本机数据？$\n$\n（任务历史、登记会话、设置与访问令牌，位于 %APPDATA%\noidle-resume）$\n$\n选「是」= 完全清理；选「否」= 仅卸载程序，保留数据。$\n默认保留：升级/重装不丢值守记录。" IDNO noidle_keep_data
    RMDir /r "$APPDATA\noidle-resume"
    DetailPrint "已清理 %APPDATA%\noidle-resume"
  noidle_keep_data:
!macroend
