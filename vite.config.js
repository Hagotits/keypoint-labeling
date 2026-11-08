import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { createProjectApi } from './server/projectApi.js'
import { createRawApi } from './server/rawApi.js'

// 저장소(axdc_gpu:~/P/labeling_store)를 SSH로 읽고 쓰는 API를 dev 서버에 붙인다.
function remoteStorage() {
  const raw = createRawApi()
  const project = createProjectApi()
  const attach = (server) => {
    server.middlewares.use(raw)
    server.middlewares.use(project)
  }
  return {
    name: 'remote-storage',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), remoteStorage()],
  server: {
    port: 5174, // 기존 로컬 저장판(5173)과 동시에 띄워도 겹치지 않도록
    strictPort: true,
  },
})
