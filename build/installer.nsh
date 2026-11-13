; Included automatically by electron-builder (build/installer.nsh).
; Uninstall keeps the user data (login sessions, translation cache, downloaded models) unless the user opts in.
; ${PRODUCT_NAME} and ${APP_FILENAME} come from electron-builder, so no product name is hard-coded here.
; This file is UTF-8 with a BOM because NSIS reads Unicode scripts that way.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 ${PRODUCT_NAME} 的用户数据？$\r$\n$\r$\n包括登录状态、翻译缓存、日志和已下载的模型文件。$\r$\n选择“否”将保留这些数据，以后重新安装可以继续使用。" IDNO rrKeepUserData
      RMDir /r "$APPDATA\${APP_FILENAME}"
      rrKeepUserData:
    ${endIf}
  ${endIf}
!macroend