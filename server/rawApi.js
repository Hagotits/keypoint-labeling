import crypto from 'node:crypto'
import path from 'node:path/posix'
import { REMOTE_HOST, REMOTE_ROOT, putCached, readCached, remoteFs as fs } from './remoteFs.js'

// 수집한 원본 사진 보관소: <저장소>/raw/
//   files/      … 업로드한 원본 (바이트 그대로, 덮어쓰지 않음)
//   index.json  … 파일별 SHA-256 · dHash · 크기 — 중복 검사 기준
const RAW = path.join(REMOTE_ROOT, 'raw')
const FILES = path.join(RAW, 'files')
const INDEX = path.join(RAW, 'index.json')

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const exists = (p) => fs.access(p).then(() => true, () => false)

const readIndex = async () => {
  if (!(await exists(INDEX))) return { version: 1, items: [] }
  return JSON.parse(await fs.readFile(INDEX, 'utf8'))
}

// index.json 읽기-수정-쓰기가 겹치지 않도록 업로드를 한 줄로 세운다
let chain = Promise.resolve()
const serial = (fn) => {
  const p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}

const cleanName = (raw) =>
  path.basename(String(raw ?? 'image')).replace(/[/\\?%*:|"<>]/g, '_') || 'image'

export function createRawApi() {
  return async function rawApi(req, res, next) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)

    // 저장소 위치 안내
    if (pathname === '/api/storage') {
      return send(res, 200, { host: REMOTE_HOST, root: REMOTE_ROOT })
    }

    // 원본 파일 서빙: /raw-files/<file>
    if (pathname.startsWith('/raw-files/')) {
      const name = pathname.slice('/raw-files/'.length)
      if (!name || name.includes('/') || name === '..') return send(res, 400, { error: 'bad path' })
      try {
        const buf = await readCached(path.join(FILES, name))
        res.statusCode = 200
        res.setHeader('Content-Type', MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'private, max-age=86400')
        return res.end(buf)
      } catch {
        return send(res, 404, { error: 'not found' })
      }
    }

    if (pathname !== '/api/raw') return next()

    try {
      // GET /api/raw — 보관소 목록(index)
      if (req.method === 'GET') {
        const idx = await readIndex()
        return send(res, 200, { items: idx.items, host: REMOTE_HOST, root: REMOTE_ROOT })
      }

      // POST /api/raw?name=&dhash=&width=&height= — 원본 하나 저장 (본문 = 원본 바이트)
      // SHA-256은 서버가 받은 바이트로 다시 계산해서 기록한다(브라우저 값을 믿지 않음).
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!body.length) return send(res, 400, { error: 'empty body' })
        const sha256 = crypto.createHash('sha256').update(body).digest('hex')
        const q = url.searchParams

        return await serial(async () => {
          const idx = await readIndex()
          const dup = idx.items.find((it) => it.sha256 === sha256)
          if (dup) return send(res, 409, { error: '이미 같은 파일이 있습니다.', duplicate: dup })

          const original = cleanName(q.get('name'))
          const ext = path.extname(original)
          const stem = path.basename(original, ext) || 'image'
          const taken = new Set(idx.items.map((it) => it.file))
          let file = `${stem}${ext}`
          for (let n = 1; taken.has(file) || (await exists(path.join(FILES, file))); n++) {
            file = `${stem}_${n}${ext}`
          }

          await fs.mkdir(FILES)
          await fs.writeFile(path.join(FILES, file), body)
          putCached(path.join(FILES, file), body)

          const item = {
            file,
            originalName: original,
            sha256,
            dhash: /^[0-9a-f]{16}$/.test(q.get('dhash') ?? '') ? q.get('dhash') : null,
            width: Number(q.get('width')) || null,
            height: Number(q.get('height')) || null,
            size: body.length,
            uploadedAt: new Date().toISOString(),
          }
          idx.items.push(item)
          await fs.writeFileAtomic(INDEX, JSON.stringify(idx, null, 2), 'utf8')
          return send(res, 201, { item })
        })
      }

      return send(res, 405, { error: 'method not allowed' })
    } catch (err) {
      return send(res, 500, { error: String(err?.message ?? err) })
    }
  }
}
