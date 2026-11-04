import './platform/installWebApi'
/** Maximum update depth 에러를 React component stack 까지 캡쳐해서 waveform.log 에 남기는 진단 — App 보다 먼저 install */
import { installReactDepthDiagnostic } from './reactDepthDiagnostic'

installReactDepthDiagnostic()

import { createRoot } from 'react-dom/client'
import App from './App'
import ExportPage from './export/ExportPage'
import { ErrorBoundary } from './ErrorBoundary'
import './tailwind.css'
import './App.css'
import './editorChrome.css'
import './platform/webAds.css'

// 내보내기 페이지(export.html)는 같은 번들로 진행 카드만 띄운다. 그 외에는 편집기.
const isExportPage = document.documentElement.dataset.autosubPage === 'export'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {isExportPage ? <ExportPage /> : <App />}
  </ErrorBoundary>
)
