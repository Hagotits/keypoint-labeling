import fs from 'node:fs/promises'
import path from 'node:path'

// project/<프로젝트 이름>/ 아래에 프로젝트가 저장된다.
//   project.json  … 메타 + 스켈레톤 정의 + 이미지 목록 + 어노테이션
//   images/       … 업로드한 원본 이미지
const META = 'project.json'
const IMG_DIR = 'images'

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

// 폴더 이름으로 쓸 수 있게 정리. 경로 탈출(../)과 OS 금지 문자를 제거한다.
export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>.]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80)
  return s || 'untitled'
}

const send = (res, status, body) => {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(json)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const exists = (p) => fs.access(p).then(() => true, () => false)

export function createProjectApi(rootDir) {
  const base = path.join(rootDir, 'project')
  const dirOf = (slug) => path.join(base, slug)

  // slug는 항상 한 단계 폴더 이름이어야 한다 (경로 탈출 방지)
  const safeSlug = (slug) => slugify(slug)

  const readMeta = async (slug) => {
    const raw = await fs.readFile(path.join(dirOf(slug), META), 'utf8')
    return JSON.parse(raw)
  }

  const writeMeta = async (slug, data) => {
    const file = path.join(dirOf(slug), META)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, file) // 저장 중 크래시로 파일이 깨지지 않도록
  }

  const listProjects = async () => {
    if (!(await exists(base))) return []
    const entries = await fs.readdir(base, { withFileTypes: true })
    const out = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      try {
        const meta = await readMeta(e.name)
        out.push({
          slug: e.name,
          name: meta.name ?? e.name,
          createdAt: meta.createdAt ?? null,
          updatedAt: meta.updatedAt ?? null,
          imageCount: meta.images?.length ?? 0,
          keypointCount: meta.keypointDefs?.length ?? 0,
          labeledCount: Object.values(meta.annotations ?? {}).filter(
            (v) => Array.isArray(v) && v.length > 0
          ).length,
        })
      } catch {
        // project.json이 없거나 깨진 폴더는 목록에서 제외
      }
    }
    out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return out
  }

  // 같은 이름의 파일이 이미 있으면 name_1.png 처럼 번호를 붙인다.
  const uniqueFileName = async (slug, rawName) => {
    const cleaned = path
      .basename(String(rawName ?? 'image'))
      .replace(/[/\\?%*:|"<>]/g, '_')
    const ext = path.extname(cleaned)
    const stem = path.basename(cleaned, ext) || 'image'
    let candidate = `${stem}${ext}`
    let n = 1
    while (await exists(path.join(dirOf(slug), IMG_DIR, candidate))) {
      candidate = `${stem}_${n++}${ext}`
    }
    return candidate
  }

  return async function projectApi(req, res, next) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)

    // 저장된 이미지 서빙: /project-files/<slug>/images/<file>
    if (pathname.startsWith('/project-files/')) {
      const rel = pathname.slice('/project-files/'.length)
      const parts = rel.split('/').filter(Boolean)
      if (parts.length !== 3 || parts[1] !== IMG_DIR || parts.some((p) => p === '..')) {
        return send(res, 400, { error: 'bad path' })
      }
      const file = path.join(dirOf(parts[0]), IMG_DIR, path.basename(parts[2]))
      try {
        const buf = await fs.readFile(file)
        res.statusCode = 200
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        return res.end(buf)
      } catch {
        return send(res, 404, { error: 'not found' })
      }
    }

    if (!pathname.startsWith('/api/projects')) return next()

    const seg = pathname.split('/').filter(Boolean) // ['api','projects', slug?, 'images'?]
    const slug = seg[2] ? safeSlug(seg[2]) : null
    const sub = seg[3]

    try {
      // GET /api/projects — 프로젝트 목록
      if (!slug && req.method === 'GET') {
        return send(res, 200, { projects: await listProjects() })
      }

      // POST /api/projects — 새 프로젝트 생성 {name}
      if (!slug && req.method === 'POST') {
        const { name } = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        if (!name?.trim()) return send(res, 400, { error: '프로젝트 이름이 필요합니다.' })
        const s = slugify(name.trim())
        if (await exists(dirOf(s))) {
          return send(res, 409, { error: '같은 이름의 프로젝트가 이미 있습니다.', slug: s })
        }
        await fs.mkdir(path.join(dirOf(s), IMG_DIR), { recursive: true })
        const now = new Date().toISOString()
        const meta = {
          name: name.trim(),
          slug: s,
          createdAt: now,
          updatedAt: now,
          keypointDefs: [],
          edges: [],
          images: [],
          annotations: {},
        }
        await writeMeta(s, meta)
        return send(res, 201, { project: meta })
      }

      if (!slug) return send(res, 400, { error: 'bad slug' })

      // GET /api/projects/:slug — 프로젝트 전체 불러오기
      if (!sub && req.method === 'GET') {
        if (!(await exists(dirOf(slug)))) return send(res, 404, { error: 'not found' })
        return send(res, 200, { project: await readMeta(slug) })
      }

      // PUT /api/projects/:slug — 스켈레톤/이미지목록/어노테이션 저장
      if (!sub && req.method === 'PUT') {
        if (!(await exists(dirOf(slug)))) return send(res, 404, { error: 'not found' })
        const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const meta = await readMeta(slug)
        const next = {
          ...meta,
          ...patch,
          name: meta.name, // 이름/slug/생성일은 서버가 관리
          slug: meta.slug,
          createdAt: meta.createdAt,
          updatedAt: new Date().toISOString(),
        }
        await writeMeta(slug, next)
        return send(res, 200, { project: next })
      }

      // DELETE /api/projects/:slug — 프로젝트 폴더째 삭제
      if (!sub && req.method === 'DELETE') {
        await fs.rm(dirOf(slug), { recursive: true, force: true })
        return send(res, 200, { ok: true })
      }

      // POST /api/projects/:slug/images?name=foo.png — 이미지 파일 하나 저장 (본문 = 바이너리)
      if (sub === IMG_DIR && req.method === 'POST') {
        if (!(await exists(dirOf(slug)))) return send(res, 404, { error: 'not found' })
        const body = await readBody(req)
        if (!body.length) return send(res, 400, { error: 'empty body' })
        const file = await uniqueFileName(slug, url.searchParams.get('name'))
        await fs.mkdir(path.join(dirOf(slug), IMG_DIR), { recursive: true })
        await fs.writeFile(path.join(dirOf(slug), IMG_DIR, file), body)
        return send(res, 201, {
          file,
          url: `/project-files/${slug}/${IMG_DIR}/${encodeURIComponent(file)}`,
        })
      }

      return send(res, 405, { error: 'method not allowed' })
    } catch (err) {
      return send(res, 500, { error: String(err?.message ?? err) })
    }
  }
}
