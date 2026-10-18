import { createRoot } from 'react-dom/client'
import '../src/shared/guest.css'
import { StatusMain } from '../src/status/main.js'

/** 状态区预览入口：宿主那一栏只有一行宽，所以容器按 300px 摆。 */
const el = document.getElementById('root')
if (el) createRoot(el).render(<StatusMain />)
