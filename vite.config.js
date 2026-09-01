import { fileURLToPath } from 'node:url'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { createProjectApi } from './server/projectApi.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// 프로젝트 저장소(project/)를 읽고 쓰는 API를 dev 서버에 붙인다.
function projectStorage() {
  const api = createProjectApi(rootDir)
  return {
    name: 'project-storage',
    configureServer(server) {
      server.middlewares.use(api)
    },
    configurePreviewServer(server) {
      server.middlewares.use(api)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), projectStorage()],
  server: {
    // 저장할 때마다 HMR이 도는 걸 막는다
    watch: { ignored: ['**/project/**'] },
  },
})
