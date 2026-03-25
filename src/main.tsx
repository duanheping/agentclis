import { createRoot } from 'react-dom/client'

import '@xterm/xterm/css/xterm.css'

import './index.css'
import App from './App.tsx'
import { AnalysisWindow } from './components/AnalysisWindow.tsx'
import { SkillSyncWindow } from './components/SkillSyncWindow.tsx'

const currentView = new URLSearchParams(window.location.search).get('view')

const element =
  currentView === 'skill-sync' ? <SkillSyncWindow />
  : currentView === 'analysis' ? <AnalysisWindow />
  : <App />

createRoot(document.getElementById('root')!).render(element)
