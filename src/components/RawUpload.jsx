import { useEffect, useMemo, useRef, useState } from 'react'
import { listRaw, uploadRaw } from '../api'
import { fingerprint, hamming, sha256 } from '../dedup'
import ThemeToggle from './ThemeToggle'

const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i
const DEFAULT_THRESHOLD = 10 // dHash 64비트 중 다른 비트 수가 이 이하면 '유사'

const fmtSize = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`

// 드래그앤드롭한 폴더 안의 파일까지 모두 꺼낸다
async function filesFromDrop(dt) {
  const entries = Array.from(dt.items ?? [])
    .map((it) => it.webkitGetAsEntry?.())
    .filter(Boolean)
  if (!entries.length) return Array.from(dt.files ?? [])
  const out = []
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)))
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e)
      }
    }
  }
  for (const e of entries) await walk(e)
  return out
}

let seq = 0

export default function RawUpload({ theme, onToggleTheme, onBack, storage }) {
  const [library, setLibrary] = useState(null) // 보관소 index (null = 불러오는 중)
  const [libError, setLibError] = useState('')
  const [rows, setRows] = useState([]) // 이번에 고른 파일들
  const [decisions, setDecisions] = useState({}) // id → 'upload' | 'skip' (사용자가 직접 고른 것)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [uploading, setUploading] = useState(false)
  const [compare, setCompare] = useState(null) // { rowId, matchIdx }
  const [dragOver, setDragOver] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const fileInput = useRef(null)
  const dirInput = useRef(null)
  const urls = useRef(new Map()) // 미리보기용 objectURL (화면을 나갈 때 정리)

  useEffect(() => {
    listRaw()
      .then(setLibrary)
      .catch((e) => setLibError(e.message))
    const map = urls.current
    return () => map.forEach((u) => URL.revokeObjectURL(u))
  }, [])

  const fileUrl = (row) => {
    if (!urls.current.has(row.id)) urls.current.set(row.id, URL.createObjectURL(row.file))
    return urls.current.get(row.id)
  }

  const patchRow = (id, patch) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const addFiles = async (list) => {
    const imgs = list.filter((f) => IMG_EXT.test(f.name) || f.type.startsWith('image/'))
    if (!imgs.length) return
    const fresh = imgs.map((file) => ({
      id: `r${++seq}`,
      file,
      name: file.webkitRelativePath || file.name,
      size: file.size,
      state: 'hashing', // hashing | ready | error | uploading | uploaded
    }))
    setRows((prev) => [...prev, ...fresh])

    // 지문 계산은 3개씩 동시에
    let next = 0
    const worker = async () => {
      while (next < fresh.length) {
        const r = fresh[next++]
        try {
          const [sha, fp] = await Promise.all([sha256(r.file), fingerprint(r.file)])
          patchRow(r.id, { state: 'ready', sha, ...fp })
        } catch (e) {
          patchRow(r.id, { state: 'error', error: `읽을 수 없는 이미지: ${e.message}` })
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  // 보관소 + 이번 목록의 앞쪽 파일과 비교해서 분류한다 (threshold가 바뀌면 다시 계산)
  const classified = useMemo(() => {
    const lib = library ?? []
    const libBySha = new Map(lib.map((it) => [it.sha256, it]))
    const seenSha = new Map()
    const earlier = []
    return rows.map((r) => {
      if (r.state !== 'ready') return { ...r, kind: r.state }
      const exactLib = libBySha.get(r.sha)
      if (exactLib) return { ...r, kind: 'exact', exactOf: { source: 'library', item: exactLib } }
      const exactBatch = seenSha.get(r.sha)
      if (exactBatch) return { ...r, kind: 'exact', exactOf: { source: 'batch', row: exactBatch } }
      seenSha.set(r.sha, r)

      const matches = []
      for (const it of lib) {
        const d = hamming(r.dhash, it.dhash)
        if (d <= threshold) matches.push({ source: 'library', item: it, dist: d })
      }
      for (const e of earlier) {
        const d = hamming(r.dhash, e.dhash)
        if (d <= threshold) matches.push({ source: 'batch', row: e, dist: d })
      }
      matches.sort((a, b) => a.dist - b.dist)
      earlier.push(r)
      return { ...r, kind: matches.length ? 'similar' : 'new', matches: matches.slice(0, 5) }
    })
  }, [rows, library, threshold])

  const decisionOf = (r) => {
    if (r.kind === 'new') return decisions[r.id] ?? 'upload'
    if (r.kind === 'similar') return decisions[r.id] ?? 'pending'
    return 'skip'
  }

  const counts = useMemo(() => {
    const c = { total: rows.length, hashing: 0, new: 0, exact: 0, similar: 0, pending: 0, toUpload: 0, uploaded: 0, error: 0 }
    for (const r of classified) {
      if (r.kind in c) c[r.kind]++
      const d = decisionOf(r)
      if (d === 'pending') c.pending++
      if (d === 'upload') c.toUpload++
    }
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classified, decisions])

  const setDecision = (id, d) => setDecisions((prev) => ({ ...prev, [id]: d }))

  const uploadAll = async () => {
    const targets = classified.filter((r) => decisionOf(r) === 'upload')
    if (!targets.length) return
    setUploading(true)
    for (const r of targets) {
      patchRow(r.id, { state: 'uploading' })
      try {
        const item = await uploadRaw(r.file, r)
        setLibrary((prev) => [...(prev ?? []), item])
        patchRow(r.id, { state: 'uploaded', savedAs: item.file })
      } catch (e) {
        if (e.status === 409) {
          // 다른 창에서 먼저 올라간 경우 — 보관소를 다시 읽으면 '동일'로 분류된다
          patchRow(r.id, { state: 'ready' })
          listRaw().then(setLibrary).catch(() => {})
        } else {
          patchRow(r.id, { state: 'error', error: `업로드 실패: ${e.message}` })
        }
      }
    }
    setUploading(false)
  }

  const clearDone = () => {
    setRows((prev) => prev.filter((r) => r.state !== 'uploaded' && classified.find((c) => c.id === r.id)?.kind !== 'exact'))
  }

  const matchSrc = (m) => (m.source === 'library' ? `/raw-files/${encodeURIComponent(m.item.file)}` : fileUrl(m.row))
  const matchName = (m) => (m.source === 'library' ? `보관소: ${m.item.file}` : `이번 목록: ${m.row.name}`)
  const matchMeta = (m) => {
    const o = m.source === 'library' ? m.item : m.row
    return `${o.width}×${o.height} · ${fmtSize(o.size)}`
  }

  const cmpRow = compare && classified.find((r) => r.id === compare.rowId)
  const cmpMatch = cmpRow?.matches?.[compare.matchIdx]

  const statusChip = (r) => {
    const d = decisionOf(r)
    switch (r.kind) {
      case 'hashing':
        return <span className="raw-chip">검사 중…</span>
      case 'uploading':
        return <span className="raw-chip">업로드 중…</span>
      case 'uploaded':
        return <span className="raw-chip ok">저장됨</span>
      case 'error':
        return <span className="raw-chip danger">오류</span>
      case 'exact':
        return <span className="raw-chip muted-chip">동일 파일 — 건너뜀</span>
      case 'similar':
        return (
          <span className={`raw-chip ${d === 'pending' ? 'warn' : ''}`}>
            {d === 'pending' ? '유사 — 확인 필요' : d === 'upload' ? '유사 — 올림' : '유사 — 건너뜀'}
          </span>
        )
      default:
        return <span className={`raw-chip ${d === 'upload' ? 'ok' : 'muted-chip'}`}>{d === 'upload' ? '새 파일' : '새 파일 — 건너뜀'}</span>
    }
  }

  return (
    <div className="raw-screen">
      <header className="raw-head">
        <div className="row">
          <button className="btn small ghost" onClick={onBack}>← 프로젝트 목록</button>
          <h1>원본 업로드 · 중복 검사</h1>
        </div>
        <div className="row">
          <span className="muted small">
            저장 위치 <code>{storage ? `${storage.host}:~/${storage.root}/raw/files/` : '…'}</code>
          </span>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>

      <div className="raw-body">
        <aside className="raw-side">
          <section>
            <h2>보관소</h2>
            {libError && <p className="error-text">{libError}</p>}
            {!libError && library === null && <p className="muted small">불러오는 중…</p>}
            {library && (
              <>
                <p className="raw-big">{library.length}<span className="muted small"> 장</span></p>
                <button className="btn tiny" onClick={() => setShowLibrary((v) => !v)}>
                  {showLibrary ? '목록 닫기' : '목록 보기'}
                </button>
                {showLibrary && (
                  <ul className="raw-lib-list">
                    {[...library].reverse().map((it) => (
                      <li key={it.sha256} title={it.sha256}>
                        <span>{it.file}</span>
                        <span className="muted small">{it.width}×{it.height}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section>
            <h2>유사 판정 기준</h2>
            <label className="field">
              <span>
                dHash 차이 ≤ <b>{threshold}</b> / 64비트
              </span>
              <input type="range" min="0" max="20" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </label>
            <p className="muted small">
              파일 내용이 완전히 같으면(SHA-256) 자동으로 건너뜁니다. 크기 변경·재압축된 같은 사진은 &lsquo;유사&rsquo;로
              표시되고 직접 고릅니다. 좌우 반전·회전·크롭된 사진은 잡지 못합니다.
            </p>
          </section>

          <section>
            <h2>이번 목록</h2>
            <dl className="raw-counts">
              <dt>전체</dt><dd>{counts.total}</dd>
              <dt>새 파일</dt><dd>{counts.new}</dd>
              <dt>동일(건너뜀)</dt><dd>{counts.exact}</dd>
              <dt>유사</dt><dd>{counts.similar}{counts.pending ? ` (확인 필요 ${counts.pending})` : ''}</dd>
              <dt>저장됨</dt><dd>{counts.uploaded}</dd>
              {counts.error > 0 && (<><dt>오류</dt><dd>{counts.error}</dd></>)}
            </dl>
            <button className="btn primary big raw-upload-btn" disabled={uploading || counts.hashing > 0 || !counts.toUpload || !library} onClick={uploadAll}>
              {uploading ? '업로드 중…' : `${counts.toUpload}장 업로드`}
            </button>
            {counts.pending > 0 && <p className="muted small">확인 필요 {counts.pending}장은 고르기 전까지 올라가지 않습니다.</p>}
            {rows.length > 0 && !uploading && (
              <button className="btn tiny ghost" onClick={clearDone}>저장됨·동일 항목 목록에서 지우기</button>
            )}
          </section>
        </aside>

        <main
          className={`raw-main ${dragOver ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setDragOver(false)
            addFiles(await filesFromDrop(e.dataTransfer))
          }}
        >
          <div className="raw-pick row">
            <button className="btn" onClick={() => fileInput.current.click()}>파일 선택</button>
            <button className="btn" onClick={() => dirInput.current.click()}>폴더 선택</button>
            <span className="muted small">또는 여기로 끌어다 놓기</span>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden
              onChange={(e) => { addFiles(Array.from(e.target.files)); e.target.value = '' }} />
            <input ref={dirInput} type="file" webkitdirectory="" multiple hidden
              onChange={(e) => { addFiles(Array.from(e.target.files)); e.target.value = '' }} />
          </div>

          {rows.length === 0 && (
            <div className="raw-empty muted">수집한 사진을 고르면 보관소의 기존 사진과 비교합니다.</div>
          )}

          <ul className="raw-list">
            {classified.map((r) => (
              <li key={r.id} className={`raw-item kind-${r.kind}`}>
                <div className="raw-thumb">{r.thumb ? <img src={r.thumb} alt="" /> : null}</div>
                <div className="raw-info">
                  <div className="row raw-title">
                    <span className="raw-name" title={r.name}>{r.name}</span>
                    {statusChip(r)}
                  </div>
                  <div className="muted small">
                    {r.width ? `${r.width}×${r.height} · ` : ''}{fmtSize(r.size)}
                    {r.savedAs && r.savedAs !== r.file.name ? ` · ${r.savedAs}(으)로 저장` : ''}
                  </div>
                  {r.error && <div className="error-text small">{r.error}</div>}
                  {r.kind === 'exact' && (
                    <div className="muted small">
                      {r.exactOf.source === 'library' ? `보관소의 ${r.exactOf.item.file}` : `이번 목록의 ${r.exactOf.row.name}`}와 바이트가 같습니다.
                    </div>
                  )}
                  {r.kind === 'similar' && (
                    <div className="raw-matches">
                      {r.matches.map((m, i) => (
                        <button key={i} className="raw-match" onClick={() => setCompare({ rowId: r.id, matchIdx: i })} title="나란히 비교">
                          <img src={matchSrc(m)} alt="" loading="lazy" />
                          <span className="small">{m.source === 'library' ? m.item.file : m.row.name}</span>
                          <span className="muted small">차이 {m.dist}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {(r.kind === 'similar' || r.kind === 'new') && (
                  <div className="raw-actions">
                    <button className={`btn tiny ${decisionOf(r) === 'upload' ? 'primary' : ''}`} onClick={() => setDecision(r.id, 'upload')}>올리기</button>
                    <button className={`btn tiny ${decisionOf(r) === 'skip' ? 'primary' : ''}`} onClick={() => setDecision(r.id, 'skip')}>건너뛰기</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </main>
      </div>

      {cmpRow && cmpMatch && (
        <div className="modal-backdrop" onClick={() => setCompare(null)}>
          <div className="raw-compare" onClick={(e) => e.stopPropagation()}>
            <div className="raw-compare-grid">
              <figure>
                <img src={fileUrl(cmpRow)} alt="" />
                <figcaption>
                  <b>새로 올릴 사진</b> {cmpRow.name}
                  <span className="muted small"> · {cmpRow.width}×{cmpRow.height} · {fmtSize(cmpRow.size)}</span>
                </figcaption>
              </figure>
              <figure>
                <img src={matchSrc(cmpMatch)} alt="" />
                <figcaption>
                  <b>{matchName(cmpMatch)}</b>
                  <span className="muted small"> · {matchMeta(cmpMatch)} · dHash 차이 {cmpMatch.dist}</span>
                </figcaption>
              </figure>
            </div>
            <div className="row raw-compare-actions">
              <button className="btn primary" onClick={() => { setDecision(cmpRow.id, 'upload'); setCompare(null) }}>다른 사진 — 올리기</button>
              <button className="btn" onClick={() => { setDecision(cmpRow.id, 'skip'); setCompare(null) }}>같은 사진 — 건너뛰기</button>
              <button className="btn ghost" onClick={() => setCompare(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
