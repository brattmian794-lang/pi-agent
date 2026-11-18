!macro customInstall
  ${if} ${isUpdated}
    # 更新后从本次安装目录启动，避免旧的开始菜单快捷方式指向其他副本。
    StrCpy $launchLink "$appExe"
  ${endif}
!macroend
