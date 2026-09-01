// dev 서버의 project 저장소 API 래퍼 (server/projectApi.js와 짝)

async function req(url, options) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`)
    err.status = res.status
    throw err
  }
  return data
}

export const listProjects = () => req('/api/projects').then((d) => d.projects)

export const createProject = (name) =>
  req('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((d) => d.project)

export const loadProject = (slug) =>
  req(`/api/projects/${encodeURIComponent(slug)}`).then((d) => d.project)

export const saveProject = (slug, patch) =>
  req(`/api/projects/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((d) => d.project)

export const deleteProject = (slug) =>
  req(`/api/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' })

// File 하나를 project/<slug>/images/ 에 저장하고 서버 경로를 돌려준다
export const uploadImage = (slug, file, name) =>
  req(
    `/api/projects/${encodeURIComponent(slug)}/images?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }
  )
