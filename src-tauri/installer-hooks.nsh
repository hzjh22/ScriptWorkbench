!define WEBVIEW2LOADER_DLL_PATH "${__FILEDIR__}\resources\WebView2Loader.dll"

!macro NSIS_HOOK_POSTINSTALL
  File "/oname=$INSTDIR\WebView2Loader.dll" "${WEBVIEW2LOADER_DLL_PATH}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\WebView2Loader.dll"
!macroend
