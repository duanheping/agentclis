import { createRoot } from 'react-dom/client'

import '@xterm/xterm/css/xterm.css'

import './index.css'
import App from './App.tsx'
import { SkillSyncWindow } from './components/SkillSyncWindow.tsx'

const currentView = new URLSearchParams(window.location.search).get('view')

createRoot(document.getElementById('root')!).render(
  currentView === 'skill-sync' ? <SkillSyncWindow /> : <App />,
)
