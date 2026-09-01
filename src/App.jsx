import { useCallback, useEffect, useRef, useState } from 'react'
import ProjectSetup from './components/ProjectSetup'
import LabelSetup from './components/LabelSetup'
import Labeler from './components/Labeler'
import { loadProject, saveProject } from './api'
import { applyTheme, loadTheme } from './theme'

const EMPTY = { keypointDefs: [], edges: [], images: [], annotations: {}, imageStatus: {} }

// step: 'project' → 'setup' → 'label'
export default function App() {
  const [step, setStep] = useState('project')
  const [project, setProject] = useState(null) // 서버에서 불러온 프로젝트 메타
  const [data, setData] = useState(EMPTY)
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [theme, setTheme] = useState(loadTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  const saveTimer = useRef(null)
  const dirty = useRef(false)

  // 변경이 생기면 잠깐 모았다가 project.json에 저장
  useEffect(() => {
    if (!project || !dirty.current) return
    clearTimeout(saveTimer.current)
    setSaveState('saving')
    saveTimer.current = setTimeout(() => {
      saveProject(project.slug, data)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'))
    }, 500)
    return () => clearTimeout(saveTimer.current)
  }, [project, data])

  const update = useCallback((patch) => {
    dirty.current = true
    setData((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
  }, [])

  const handleOpen = async (slug) => {
    const p = await loadProject(slug)
    dirty.current = false
    setProject(p)
    setData({
      keypointDefs: p.keypointDefs ?? [],
      edges: p.edges ?? [],
      images: p.images ?? [],
      annotations: p.annotations ?? {},
      imageStatus: p.imageStatus ?? {},
    })
    setSaveState('idle')
    // 스켈레톤과 이미지가 이미 있으면 바로 라벨링 화면으로
    setStep(p.keypointDefs?.length && p.images?.length ? 'label' : 'setup')
  }

  const handleClose = () => {
    clearTimeout(saveTimer.current)
    if (project && dirty.current) saveProject(project.slug, data).catch(() => {})
    dirty.current = false
    setProject(null)
    setData(EMPTY)
    setStep('project')
  }

  if (step === 'project') {
    return (
      <div className="app">
        <ProjectSetup onOpen={handleOpen} theme={theme} onToggleTheme={toggleTheme} />
      </div>
    )
  }

  return (
    <div className="app">
      {step === 'setup' && (
        <LabelSetup
          project={project}
          keypointDefs={data.keypointDefs}
          edges={data.edges}
          images={data.images}
          saveState={saveState}
          theme={theme}
          onToggleTheme={toggleTheme}
          onChange={update}
          onBack={handleClose}
          onDone={() => setStep('label')}
        />
      )}
      {step === 'label' && (
        <Labeler
          project={project}
          projectName={project.name}
          keypointDefs={data.keypointDefs}
          edges={data.edges}
          images={data.images}
          annotations={data.annotations}
          imageStatus={data.imageStatus}
          saveState={saveState}
          theme={theme}
          onToggleTheme={toggleTheme}
          onChange={update}
          onEditSetup={() => setStep('setup')}
          onBack={handleClose}
        />
      )}
    </div>
  )
}
