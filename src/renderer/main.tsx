import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useApp } from './state/store'
import { installTestHook } from './testHook'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// The test hook only goes up once the workspace is on screen, so `ready` means "hydrated".
void useApp.getState().hydrate().then(installTestHook)
