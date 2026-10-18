import { createRoot } from 'react-dom/client'
import '../src/shared/guest.css'
import { Panel } from '../src/panel/Panel.js'

/** 面板预览入口：只挂真面板，数据来自 `?scenario=`（见 scenarios.ts）。 */
const el = document.getElementById('root')
if (el) createRoot(el).render(<Panel />)
