import { createRoot } from 'react-dom/client'
import { Panel } from './Panel.js'

const el = document.getElementById('root')
if (el) createRoot(el).render(<Panel />)
