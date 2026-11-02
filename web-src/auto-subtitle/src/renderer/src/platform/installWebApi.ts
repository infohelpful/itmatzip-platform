/** Must be the first import of main.tsx: the renderer reads `window.api` while modules evaluate. */
import { createWebApi } from './webApi'

if (!window.api) window.api = createWebApi()
