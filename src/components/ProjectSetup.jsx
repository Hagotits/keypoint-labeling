import { useEffect, useState } from 'react'
import { createProject, deleteProject, listProjects } from '../api'
import ThemeToggle from './ThemeToggle'

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(
    d.getDate()
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`
}

export default function ProjectSetup({ onOpen, onOpenRaw, storage, theme, onToggleTheme }) {
  const [name, setName] = useState('')
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))

  useEffect(() => {
    refresh()
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    setError('')
    try {
      const project = await createProject(name.trim())
      onOpen(project.slug)
    } catch (err) {
      setError(err.message)
      refresh()
    }
  }

  const remove = async (slug, projectName) => {
    if (!confirm(`'${projectName}' 프로젝트를 폴더째 삭제할까요?\n이미지와 라벨이 모두 사라집니다.`))
      return
    await deleteProject(slug)
    refresh()
  }

  return (
    <div className="center-screen">
      <div className="card">
        <div className="card-head">
          <div>
            <h1>Skeleton Keypoint Labeler</h1>
            <p className="muted">
              프로젝트는{' '}
              <code>
                {storage ? `${storage.host}:~/${storage.root}` : '원격 저장소'}/project/&lt;이름&gt;/
              </code>{' '}
              에 저장됩니다.
            </p>
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>

        <button className="btn" type="button" onClick={onOpenRaw}>
          원본 업로드 · 중복 검사
        </button>

        <form onSubmit={submit}>
          <label className="field">
            <span>새 프로젝트 이름</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 사람 포즈 라벨링"
            />
          </label>
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            프로젝트 생성
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}

        <section className="project-list-section">
          <h2>저장된 프로젝트</h2>
          {loading && <p className="muted small">불러오는 중… (서버 연결)</p>}
          {!loading && projects.length === 0 && (
            <p className="muted small">아직 저장된 프로젝트가 없습니다.</p>
          )}
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.slug}>
                <button className="project-open" onClick={() => onOpen(p.slug)}>
                  <span className="project-name">{p.name}</span>
                  <span className="muted small">
                    이미지 {p.imageCount}장 · 키포인트 {p.keypointCount}개 · 라벨링{' '}
                    {p.labeledCount}장 · {fmtDate(p.updatedAt)}
                  </span>
                </button>
                <button className="btn tiny danger" onClick={() => remove(p.slug, p.name)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
