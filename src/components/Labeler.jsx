import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildFlipPairs, mirrorKeypoints, uid, importImageFiles } from '../utils'
import SaveBadge from './SaveBadge'
import KeySettings from './KeySettings'
import StatusStar from './StatusStar'
import { useDialogs } from './Dialogs'
import ThemeToggle from './ThemeToggle'
import { isUndoCombo, loadKeymap, matches, saveKeymap } from '../keymap'

// 설정 단계에서 그린 기준 스켈레톤 모양을 bbox 안에 맞춰 초기 배치.
// 드래그 방향(4방향 스냅)에 맞춰 회전: 드래그 시작 지점이 템플릿의 위쪽(예: 머리)이 된다.
function layoutKeypoints(defs, box, delta = { x: 0, y: 1 }) {
  let theta
  if (Math.abs(delta.x) >= Math.abs(delta.y)) {
    theta = delta.x >= 0 ? -Math.PI / 2 : Math.PI / 2
  } else {
    theta = delta.y >= 0 ? 0 : Math.PI
  }
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const cx = defs.reduce((s, d) => s + d.tx, 0) / defs.length
  const cy = defs.reduce((s, d) => s + d.ty, 0) / defs.length
  const pts = defs.map((d) => ({
    defId: d.id,
    x: cx + (d.tx - cx) * cos - (d.ty - cy) * sin,
    y: cy + (d.tx - cx) * sin + (d.ty - cy) * cos,
  }))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const tw = maxX - minX
  const th = maxY - minY
  const pad = 0.06
  return pts.map((p) => {
    const nx = tw === 0 ? 0.5 : (p.x - minX) / tw
    const ny = th === 0 ? 0.5 : (p.y - minY) / th
    return {
      defId: p.defId,
      x: box.x + box.w * (pad + nx * (1 - pad * 2)),
      y: box.y + box.h * (pad + ny * (1 - pad * 2)),
      v: 2, // 가시성: 2=보임, 1=가려짐(추정), 0=없음(좌표 null)
    }
  })
}

const V_LABELS = { 2: '보임', 1: '가려짐', 0: '없음' }

// 예전 툴에서 만든 데이터는 키포인트가 박스 밖으로 나간 경우가 있다.
// (박스를 대충 그려놓고 키포인트만 옮긴 데이터라 키포인트 쪽이 더 정확하다.)
// 박스를 키포인트가 전부 들어가는 크기로 넓혀서 바로잡는다. 좌표는 건드리지 않고,
// 키포인트가 이미지 밖에 찍혀 있으면 박스도 이미지 밖으로 나가는 걸 허용한다.
function fitBoxToKeypoints(inst) {
  const pts = inst.keypoints.filter((k) => k.x != null && k.y != null)
  if (pts.length === 0) return { inst, changed: false }

  const xs = pts.map((k) => k.x)
  const ys = pts.map((k) => k.y)
  const x0 = Math.min(inst.x, ...xs)
  const y0 = Math.min(inst.y, ...ys)
  const x1 = Math.max(inst.x + inst.w, ...xs)
  const y1 = Math.max(inst.y + inst.h, ...ys)

  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  const changed =
    Math.abs(box.x - inst.x) > 0.5 ||
    Math.abs(box.y - inst.y) > 0.5 ||
    Math.abs(box.w - inst.w) > 0.5 ||
    Math.abs(box.h - inst.h) > 0.5
  return { inst: changed ? { ...inst, ...box } : inst, changed }
}


export default function Labeler({
  project,
  projectName,
  keypointDefs,
  edges,
  images,
  annotations, // imageId -> [instance] (프로젝트에 저장됨)
  imageStatus, // imageId -> true면 사람이 '완료'로 표시한 것 (선택 기능)
  saveState,
  theme,
  onToggleTheme,
  onChange,
  onEditSetup,
  onBack,
}) {
  const [currentId, setCurrentId] = useState(images[0]?.id)
  const [addingImages, setAddingImages] = useState(false)

  // 어노테이션/이미지 목록은 App이 들고 project.json에 저장한다
  const setAnnotations = useCallback(
    (next) =>
      onChange((cur) => ({
        annotations: typeof next === 'function' ? next(cur.annotations) : next,
      })),
    [onChange]
  )
  // 별 표시: 라벨이 하나라도 있으면 자동으로 반 별(작업중),
  // 사람이 클릭해서 완료로 표시하면 꽉 찬 노란 별. 안 써도 그만인 보조 표시.
  const isDone = useCallback(
    (imageId) => imageStatus?.[imageId] === true || imageStatus?.[imageId] === 2,
    [imageStatus]
  )

  const starState = useCallback(
    (imageId) => (isDone(imageId) ? 2 : (annotations[imageId] || []).length > 0 ? 1 : 0),
    [isDone, annotations]
  )

  const toggleDone = useCallback(
    (imageId) =>
      onChange((cur) => {
        const next = { ...cur.imageStatus }
        if (next[imageId] === true || next[imageId] === 2) delete next[imageId]
        else next[imageId] = true
        return { imageStatus: next }
      }),
    [onChange]
  )

  const addImages = useCallback(
    (imgs) => onChange((cur) => ({ images: [...cur.images, ...imgs] })),
    [onChange]
  )
  const [selectedId, setSelectedId] = useState(null)
  const [selectedKp, setSelectedKp] = useState(null) // {instId, defId} 단축키 대상 포인트
  const [placing, setPlacing] = useState(null) // {instId, defId} v=0 포인트 다시 찍기 모드
  const [draft, setDraft] = useState(null) // 그리는 중인 bbox
  const [baseScale, setBaseScale] = useState(1) // 이미지 원본 대비 화면 표시 배율 (줌 제외)
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 }) // 줌 배율 + 이동량(화면 px)
  const [spacePan, setSpacePan] = useState(false) // Space 누른 상태 = 드래그로 화면 이동
  const [pointSize, setPointSize] = useState(4) // 키포인트 반지름 (화면 px 기준)
  const [labelMode, setLabelMode] = useState('all') // 이름 표시: all | selected | none
  const [focusMode, setFocusMode] = useState(true) // 선택한 박스만 밝게 + 다른 객체 숨김
  const [keymap, setKeymap] = useState(loadKeymap) // 사용자가 바꾼 단축키
  const [keySettingsOpen, setKeySettingsOpen] = useState(false)
  const [dupKeyDown, setDupKeyDown] = useState(false) // 복사키를 누르고 있는 중
  const [canUndo, setCanUndo] = useState(false)
  const { notify, ask, dialogNode, dialogOpen } = useDialogs()

  const svgRef = useRef(null)
  const imgRef = useRef(null)
  const dragRef = useRef(null)
  const fileRef = useRef(null)
  const importRef = useRef(null)
  const wrapRef = useRef(null)
  const holderRef = useRef(null)
  const clipRef = useRef(null) // 복사한 객체 (이미지 사이에도 붙여넣기 가능)
  const historyRef = useRef([]) // 되돌리기용 이전 어노테이션 스냅샷

  // 이름으로 찾은 left/right 키포인트 짝 (반전할 때 라벨을 맞바꾸는 데 쓴다)
  const flipPairs = useMemo(() => buildFlipPairs(keypointDefs), [keypointDefs])

  const image = images.find((im) => im.id === currentId) || images[0]
  const instances = annotations[image?.id] || []
  const scale = baseScale * view.z // 원본 좌표 → 화면 px 변환 배율

  // 화면 표시 배율 추적 (핸들/포인트 크기를 화면 기준으로 일정하게)
  useEffect(() => {
    const img = imgRef.current
    if (!img || !image) return
    const update = () => {
      if (img.clientWidth) setBaseScale(img.clientWidth / image.width)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(img)
    return () => ro.disconnect()
  }, [image])

  // 휠 줌 (커서 위치 기준). preventDefault를 위해 non-passive로 직접 등록
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const holder = holderRef.current
      if (!holder) return
      const rect = holder.getBoundingClientRect()
      setView((v) => {
        const nz = Math.min(16, Math.max(1, v.z * Math.exp(-e.deltaY * 0.0015)))
        if (nz === v.z) return v
        if (nz === 1) return { z: 1, tx: 0, ty: 0 }
        // 커서 아래 지점이 고정되도록 이동량 보정
        const qx = (e.clientX - rect.left) / v.z
        const qy = (e.clientY - rect.top) / v.z
        return { z: nz, tx: v.tx + (v.z - nz) * qx, ty: v.ty + (v.z - nz) * qy }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 복사키(기본 A)를 누르고 있는 동안 박스를 끌면 복사본이 만들어진다
  useEffect(() => {
    const down = (e) => {
      if (e.target.tagName === 'INPUT' || keySettingsOpen) return
      if (matches(keymap, 'duplicate', e)) setDupKeyDown(true)
    }
    const up = (e) => {
      if (matches(keymap, 'duplicate', e)) setDupKeyDown(false)
    }
    const blur = () => setDupKeyDown(false) // 창을 벗어나면 눌림 상태가 남지 않게
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [keymap, keySettingsOpen])

  // Space 누르고 있는 동안 드래그 = 화면 이동
  useEffect(() => {
    const down = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault()
        setSpacePan(true)
      }
    }
    const up = (e) => {
      if (e.code === 'Space') setSpacePan(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const setInstances = useCallback(
    (updater) => {
      setAnnotations((prev) => {
        const cur = prev[image.id] || []
        return { ...prev, [image.id]: typeof updater === 'function' ? updater(cur) : updater }
      })
    },
    [image?.id, setAnnotations]
  )

  // 되돌리기: 값을 바꾸기 "직전"에 스냅샷을 남긴다.
  // 드래그는 시작할 때 한 번만 남겨서, 한 번의 드래그가 한 번에 되돌려지도록 한다.
  const pushHistory = useCallback(() => {
    historyRef.current.push(annotations)
    if (historyRef.current.length > 100) historyRef.current.shift()
    setCanUndo(true)
  }, [annotations])

  // 이미지 이동 (방향키 / Enter)
  const goToImage = useCallback(
    (delta) => {
      const idx = images.findIndex((im) => im.id === currentId)
      const next = images[Math.min(images.length - 1, Math.max(0, idx + delta))]
      if (!next || next.id === currentId) return
      setCurrentId(next.id)
      setSelectedId(null)
      setSelectedKp(null)
      setPlacing(null)
      setView({ z: 1, tx: 0, ty: 0 })
    },
    [images, currentId]
  )

  // 드래그 시작 시점의 스냅샷을 들고 있다가, 처음 값이 바뀔 때 한 번만 기록한다
  const commitDragHistory = (drag) => {
    if (!drag?.hist || drag.hist.committed) return
    drag.hist.committed = true
    historyRef.current.push(drag.hist.snapshot)
    if (historyRef.current.length > 100) historyRef.current.shift()
    setCanUndo(true)
  }

  const undo = useCallback(() => {
    const prev = historyRef.current.pop()
    setCanUndo(historyRef.current.length > 0)
    if (!prev) return
    setAnnotations(prev)
    // 되돌린 뒤에도 남아 있는 객체면 선택을 유지한다
    const restored = prev[currentId] || []
    setSelectedId((cur) => (restored.some((i) => i.id === cur) ? cur : null))
    setSelectedKp(null)
    setPlacing(null)
    setDraft(null)
  }, [currentId, setAnnotations])

  // 클라이언트 좌표 → 이미지 원본 좌표
  const toImageCoords = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * image.width,
      y: ((e.clientY - rect.top) / rect.height) * image.height,
    }
  }

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

  const copyOf = (inst, dx = 0, dy = 0) => ({
    ...inst,
    id: uid(),
    locked: false, // 복사본은 고정 해제 상태로
    x: inst.x + dx,
    y: inst.y + dy,
    keypoints: inst.keypoints.map((k) =>
      k.x == null ? { ...k } : { ...k, x: k.x + dx, y: k.y + dy }
    ),
  })

  // ⌘/Ctrl + 박스 드래그: 그 자리에 복사본을 만들고 복사본을 끌고 다닌다
  const startDuplicateDrag = (e, inst) => {
    pushHistory()
    const copy = copyOf(inst)
    setInstances((cur) => [...cur, copy])
    dragRef.current = {
      mode: 'move',
      instId: copy.id,
      start: toImageCoords(e),
      orig: {
        x: copy.x,
        y: copy.y,
        w: copy.w,
        h: copy.h,
        keypoints: copy.keypoints.map((k) => ({ ...k })),
      },
    }
    setSelectedId(copy.id)
    setSelectedKp(null)
    svgRef.current.setPointerCapture(e.pointerId)
  }

  // 보정된 예전 데이터는 박스가 이미지 밖으로 삐져나갈 수 있다.
  // 그런 박스는 이동/크기조절할 때 이미지 안으로 끌어당기지 않는다
  // (끌어당기면 키포인트가 같이 딸려가서 좌표가 틀어짐).
  const fitsInImage = (b) =>
    b.x >= 0 && b.y >= 0 && b.x + b.w <= image.width && b.y + b.h <= image.height

  // 집중 모드: 작업 중인 박스 영역만 밝게 두고 나머지는 어둡게, 다른 객체는 숨긴다.
  // 가림(occlusion) 판단할 때 옆 객체의 박스/키포인트에 시선이 끌리지 않도록.
  const selectedInst = instances.find((i) => i.id === selectedId) || null
  const focusRect = draft ?? (selectedInst && { x: selectedInst.x, y: selectedInst.y, w: selectedInst.w, h: selectedInst.h })
  const focusOn = focusMode && !!focusRect
  const visibleInstances = focusOn ? (selectedInst && !draft ? [selectedInst] : []) : instances

  // Tab = 선택한 박스 고정/해제. 고정하면 박스는 못 움직이고 키포인트만 수정된다.
  const toggleLock = useCallback(
    (instId) => {
      pushHistory()
      setInstances((cur) =>
        cur.map((inst) => (inst.id === instId ? { ...inst, locked: !inst.locked } : inst))
      )
    },
    [setInstances, pushHistory]
  )

  // --- 드래그 시작 핸들러들 ---
  // v 값 변경. v=0이면 좌표를 null로 비우고, v>=1인데 좌표가 없으면 박스 중앙에 배치
  const setKpV = useCallback(
    (instId, defId, v) => {
      pushHistory()
      setInstances((cur) =>
        cur.map((inst) => {
          if (inst.id !== instId) return inst
          return {
            ...inst,
            keypoints: inst.keypoints.map((k) => {
              if (k.defId !== defId) return k
              if (v === 0) return { ...k, v: 0, x: null, y: null }
              if (k.x == null || k.y == null)
                return { ...k, v, x: inst.x + inst.w / 2, y: inst.y + inst.h / 2 }
              return { ...k, v }
            }),
          }
        })
      )
    },
    [setInstances, pushHistory]
  )

  const cycleKpV = useCallback(
    (instId, defId) => {
      const inst = instances.find((i) => i.id === instId)
      const k = inst?.keypoints.find((k) => k.defId === defId)
      if (!k) return
      setKpV(instId, defId, k.v === 2 ? 1 : k.v === 1 ? 0 : 2)
    },
    [instances, setKpV]
  )

  const startDrawBox = (e) => {
    // 휠 버튼 드래그 또는 Space+드래그 = 화면 이동(팬)
    if (e.button === 1 || (e.button === 0 && spacePan)) {
      e.preventDefault()
      dragRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, origT: { ...view } }
      svgRef.current.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const p = toImageCoords(e)
    // v=0 포인트 다시 찍기 모드: 클릭 위치에 배치하고 v=2로
    if (placing) {
      const { instId, defId } = placing
      // 클릭 위치가 박스 밖이면 박스 경계로 당겨서 찍는다
      pushHistory()
      const b = instances.find((i) => i.id === instId)
      const x = b ? clamp(p.x, b.x, b.x + b.w) : clamp(p.x, 0, image.width)
      const y = b ? clamp(p.y, b.y, b.y + b.h) : clamp(p.y, 0, image.height)
      setInstances((cur) =>
        cur.map((inst) =>
          inst.id === instId
            ? {
                ...inst,
                keypoints: inst.keypoints.map((k) =>
                  k.defId === defId ? { ...k, x, y, v: 2 } : k
                ),
              }
            : inst
        )
      )
      setSelectedId(instId)
      setSelectedKp({ instId, defId })
      setPlacing(null)
      return
    }
    dragRef.current = { mode: 'draw', start: p }
    setSelectedId(null)
    setSelectedKp(null)
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
    svgRef.current.setPointerCapture(e.pointerId)
  }

  const startMoveBox = (e, inst) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (dupKeyDown) return startDuplicateDrag(e, inst)
    if (inst.locked) {
      // 고정된 박스는 선택만 하고 이동은 막는다
      setSelectedId(inst.id)
      setSelectedKp(null)
      return
    }
    const p = toImageCoords(e)
    dragRef.current = {
      mode: 'move',
      instId: inst.id,
      start: p,
      hist: { snapshot: annotations, committed: false },
      orig: {
        x: inst.x,
        y: inst.y,
        w: inst.w,
        h: inst.h,
        keypoints: inst.keypoints.map((k) => ({ ...k })),
      },
    }
    setSelectedId(inst.id)
    setSelectedKp(null)
    svgRef.current.setPointerCapture(e.pointerId)
  }

  const startResize = (e, inst, handle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // 경계를 잡아도 복사키가 눌려 있으면 크기조절이 아니라 복사
    if (dupKeyDown) return startDuplicateDrag(e, inst)
    if (inst.locked) return
    dragRef.current = {
      mode: 'resize',
      instId: inst.id,
      handle,
      start: toImageCoords(e),
      hist: { snapshot: annotations, committed: false },
      orig: { x: inst.x, y: inst.y, w: inst.w, h: inst.h, keypoints: inst.keypoints.map((k) => ({ ...k })) },
    }
    setSelectedId(inst.id)
    svgRef.current.setPointerCapture(e.pointerId)
  }

  const startMovePoint = (e, inst, defId) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // 키포인트 위에서 잡아도 복사키가 눌려 있으면 박스 복사 (박스 영역 전체에서 동일)
    if (dupKeyDown) return startDuplicateDrag(e, inst)
    const p = toImageCoords(e)
    const k = inst.keypoints.find((kp) => kp.defId === defId)
    dragRef.current = {
      mode: 'point',
      instId: inst.id,
      defId,
      // 잡은 지점과 포인트 중심의 오프셋을 유지해 드래그 시 점이 커서로 튀지 않게
      offX: (k?.x ?? p.x) - p.x,
      offY: (k?.y ?? p.y) - p.y,
      // 키포인트는 자기 박스를 벗어날 수 없다
      box: { x: inst.x, y: inst.y, w: inst.w, h: inst.h },
      hist: { snapshot: annotations, committed: false },
    }
    setSelectedId(inst.id)
    setSelectedKp({ instId: inst.id, defId })
    svgRef.current.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'pan') {
      setView((v) => ({
        ...v,
        tx: drag.origT.tx + (e.clientX - drag.sx),
        ty: drag.origT.ty + (e.clientY - drag.sy),
      }))
      return
    }
    const p = toImageCoords(e)

    if (drag.mode === 'draw') {
      // 이미지 바깥으로는 박스가 그려지지 않게 커서 위치를 경계로 제한
      const px = clamp(p.x, 0, image.width)
      const py = clamp(p.y, 0, image.height)
      drag.last = { x: px, y: py } // 회전 방향 계산용
      setDraft({
        x: Math.min(drag.start.x, px),
        y: Math.min(drag.start.y, py),
        w: Math.abs(px - drag.start.x),
        h: Math.abs(py - drag.start.y),
      })
    } else if (drag.mode === 'resize') {
      commitDragHistory(drag)
      const o = drag.orig
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      const bound = fitsInImage(o) // 이미 밖으로 나간 박스는 경계로 제한하지 않음
      const lim = (v, lo, hi) => (bound ? clamp(v, lo, hi) : v)

      // 잡은 변을 반대편 너머로 끌면 부호가 뒤집히면서 박스가 반전된다
      let left = o.x
      let right = o.x + o.w
      let top = o.y
      let bottom = o.y + o.h
      if (drag.handle.includes('e')) right = lim(right + dx, 0, image.width)
      if (drag.handle.includes('w')) left = lim(left + dx, 0, image.width)
      if (drag.handle.includes('s')) bottom = lim(bottom + dy, 0, image.height)
      if (drag.handle.includes('n')) top = lim(top + dy, 0, image.height)

      const flipX = right < left
      const flipY = bottom < top
      const box = {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        w: Math.abs(right - left),
        h: Math.abs(bottom - top),
      }
      drag.flipped = flipX !== flipY // 반전 안내 문구용
      setInstances((cur) =>
        cur.map((inst) =>
          inst.id === drag.instId
            ? {
                ...inst,
                ...box,
                // 키포인트도 박스 상대 위치를 유지하며 함께 스케일/반전.
                // 한 축만 뒤집었으면 left/right 짝의 라벨도 서로 바뀐다.
                keypoints: mirrorKeypoints(o.keypoints, o, box, flipX, flipY, flipPairs),
              }
            : inst
        )
      )
    } else if (drag.mode === 'move') {
      commitDragHistory(drag)
      // 박스가 이미지 밖으로 나가지 않게 이동량을 제한 (이미 밖으로 나간 박스는 그대로 둠)
      const bound = fitsInImage(drag.orig)
      const rawX = drag.orig.x + (p.x - drag.start.x)
      const rawY = drag.orig.y + (p.y - drag.start.y)
      const nx = bound ? clamp(rawX, 0, Math.max(0, image.width - drag.orig.w)) : rawX
      const ny = bound ? clamp(rawY, 0, Math.max(0, image.height - drag.orig.h)) : rawY
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
      const dx = nx - drag.orig.x
      const dy = ny - drag.orig.y
      setInstances((cur) =>
        cur.map((inst) =>
          inst.id === drag.instId
            ? {
                ...inst,
                x: nx,
                y: ny,
                keypoints: drag.orig.keypoints.map((k) =>
                  k.x == null ? { ...k } : { ...k, x: k.x + dx, y: k.y + dy }
                ),
              }
            : inst
        )
      )
    } else if (drag.mode === 'point') {
      commitDragHistory(drag)
      const b = drag.box
      const x = clamp(p.x + drag.offX, b.x, b.x + b.w)
      const y = clamp(p.y + drag.offY, b.y, b.y + b.h)
      setInstances((cur) =>
        cur.map((inst) =>
          inst.id === drag.instId
            ? {
                ...inst,
                keypoints: inst.keypoints.map((k) =>
                  k.defId === drag.defId ? { ...k, x, y } : k
                ),
              }
            : inst
        )
      )
    }
  }

  const onPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.mode !== 'draw') return
    // 너무 작은 박스(클릭 수준)는 무시
    if (draft && draft.w > 8 / scale && draft.h > 8 / scale) {
      const delta = drag.last
        ? { x: drag.last.x - drag.start.x, y: drag.last.y - drag.start.y }
        : { x: 0, y: 1 }
      const inst = {
        id: uid(),
        ...draft,
        keypoints: layoutKeypoints(keypointDefs, draft, delta),
      }
      pushHistory()
      setInstances((cur) => [...cur, inst])
      setSelectedId(inst.id)
    }
    setDraft(null)
  }

  // 단축키. 어떤 키가 어떤 동작인지는 keymap(사용자 설정)이 정한다.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (keySettingsOpen || dialogOpen) return // 설정 창/대화상자가 키 입력을 받는 중
      const is = (action) => matches(keymap, action, e)

      // Esc는 고정 (선택 해제 / 취소)
      if (e.key === 'Escape') {
        setPlacing(null)
        setSelectedKp(null)
        return
      }
      if (is('undo') || isUndoCombo(e)) {
        e.preventDefault()
        undo()
        return
      }
      if (is('prevImage')) {
        e.preventDefault()
        goToImage(-1)
        return
      }
      if (is('nextImage')) {
        e.preventDefault()
        goToImage(1)
        return
      }
      if (is('copy')) {
        const inst = instances.find((i) => i.id === selectedId)
        if (!inst) return
        e.preventDefault()
        clipRef.current = { ...inst, keypoints: inst.keypoints.map((k) => ({ ...k })) }
        return
      }
      if (is('paste')) {
        const src = clipRef.current
        if (!src) return
        e.preventDefault()
        // 원본에 정확히 겹치지 않게 살짝 어긋나게 붙여넣는다
        const off = Math.max(8, Math.min(src.w, src.h) * 0.15)
        const copy = copyOf(src, off, off)
        pushHistory()
        setInstances((cur) => [...cur, copy])
        setSelectedId(copy.id)
        setSelectedKp(null)
        return
      }
      if (is('lock')) {
        // Tab에 걸려 있으면 포커스 이동 대신 고정 토글로 쓴다
        e.preventDefault()
        if (selectedId) toggleLock(selectedId)
        return
      }
      if (selectedKp) {
        const v = is('visible') ? 2 : is('occluded') ? 1 : is('absent') ? 0 : null
        if (v !== null) {
          e.preventDefault()
          setKpV(selectedKp.instId, selectedKp.defId, v)
          return
        }
        if (is('cycle')) {
          e.preventDefault()
          cycleKpV(selectedKp.instId, selectedKp.defId)
          return
        }
        if (is('remove')) {
          e.preventDefault()
          setKpV(selectedKp.instId, selectedKp.defId, 0)
          return
        }
      }
      if (is('remove') && selectedId) {
        // 고정된 박스는 실수로 지워지지 않게 보호 (고정 해제 후 삭제)
        if (instances.find((inst) => inst.id === selectedId)?.locked) return
        e.preventDefault()
        pushHistory()
        setInstances((cur) => cur.filter((inst) => inst.id !== selectedId))
        setSelectedId(null)
        setSelectedKp(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    keymap,
    keySettingsOpen,
    dialogOpen,
    selectedId,
    selectedKp,
    instances,
    setInstances,
    setKpV,
    cycleKpV,
    toggleLock,
    undo,
    pushHistory,
    goToImage,
  ])

  const exportJSON = async () => {
    const nameOf = (id) => keypointDefs.find((d) => d.id === id)?.name

    // 저장 전 검증
    const problems = []
    const allZero = []
    images.forEach((im) => {
      ;(annotations[im.id] || []).forEach((inst, idx) => {
        inst.keypoints.forEach((k) => {
          const kpName = nameOf(k.defId)
          if (k.v === 0 && (k.x != null || k.y != null))
            problems.push(`${im.name} / 객체 ${idx + 1} / ${kpName}: v=0인데 좌표가 있음`)
          if (k.v >= 1 && (k.x == null || k.y == null))
            problems.push(`${im.name} / 객체 ${idx + 1} / ${kpName}: v=${k.v}인데 좌표가 없음`)
        })
        if (inst.keypoints.length > 0 && inst.keypoints.every((k) => k.v === 0))
          allZero.push(`${im.name} / 객체 ${idx + 1}`)
      })
    })
    if (problems.length > 0) {
      await ask(
        '저장할 수 없습니다',
        `다음 키포인트를 확인하세요:\n\n` +
          problems.slice(0, 15).join('\n') +
          (problems.length > 15 ? `\n… 외 ${problems.length - 15}건` : ''),
        [{ label: '확인', value: null, tone: 'primary' }]
      )
      return
    }
    if (allZero.length > 0) {
      const ok = await ask(
        '확인이 필요합니다',
        `모든 키포인트가 v=0(없음)인 객체가 있습니다. 실수일 수 있습니다:\n\n` +
          allZero.slice(0, 10).join('\n') +
          (allZero.length > 10 ? `\n… 외 ${allZero.length - 10}건` : ''),
        [
          { label: '취소', value: false },
          { label: '그래도 저장', value: true, tone: 'primary' },
        ]
      )
      if (!ok) return
    }

    const data = {
      project: projectName,
      keypoints: keypointDefs.map((d) => d.name),
      visibility: {
        0: 'not labeled, x/y null',
        1: 'occluded, estimated',
        2: 'visible',
      },
      skeleton: edges.map(([a, b]) => [nameOf(a), nameOf(b)]),
      images: images.map((im) => ({
        name: im.name,
        width: im.width,
        height: im.height,
        annotations: (annotations[im.id] || []).map((inst) => ({
          bbox: [
            Math.round(inst.x),
            Math.round(inst.y),
            Math.round(inst.w),
            Math.round(inst.h),
          ],
          keypoints: inst.keypoints.map((k) => ({
            name: nameOf(k.defId),
            x: k.x == null ? null : Math.round(k.x),
            y: k.y == null ? null : Math.round(k.y),
            v: k.v,
          })),
        })),
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    downloadBlob(blob)
    notify('JSON을 내보냈습니다.', 'ok')
  }

  const downloadBlob = (blob) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${projectName.replace(/\s+/g, '_')}_annotations.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // 어노테이션 JSON 불러오기. v 필드가 없는 기존 파일은
  // 좌표가 있으면 v=2, 없으면 v=0으로 간주한다.
  const importJSON = async (file) => {
    let data
    try {
      data = JSON.parse(await file.text())
    } catch {
      notify('JSON 파일을 읽을 수 없습니다.', 'error')
      return
    }
    const base = (n) => String(n || '').split('/').pop()
    const defByName = Object.fromEntries(keypointDefs.map((d) => [d.name, d]))
    const unknownKps = new Set()
    const skippedImages = []
    const imported = {}
    let count = 0
    let fixedBoxes = 0 // 키포인트가 박스를 벗어나 크기를 보정한 객체 수

    for (const entry of data.images || []) {
      const im = images.find((i) => i.name === entry.name || base(i.name) === base(entry.name))
      if (!im) {
        if (entry.annotations?.length) skippedImages.push(entry.name)
        continue
      }
      imported[im.id] = (entry.annotations || []).map((a) => {
        const byName = {}
        for (const k of a.keypoints || []) {
          if (!defByName[k.name]) unknownKps.add(k.name)
          byName[k.name] = k
        }
        const inst = {
          id: uid(),
          x: a.bbox?.[0] ?? 0,
          y: a.bbox?.[1] ?? 0,
          w: a.bbox?.[2] ?? 0,
          h: a.bbox?.[3] ?? 0,
          // 정의된 키포인트 개수만큼 항상 채운다 (파일에 없으면 v=0)
          keypoints: keypointDefs.map((d) => {
            const k = byName[d.name]
            const has = k && k.x != null && k.y != null
            let v = k?.v != null ? k.v : has ? 2 : 0
            if (![0, 1, 2].includes(v)) v = has ? 2 : 0
            return v === 0 || !has
              ? { defId: d.id, x: null, y: null, v: 0 }
              : { defId: d.id, x: k.x, y: k.y, v }
          }),
        }
        // 박스 밖으로 나간 키포인트가 있으면 박스를 그 크기에 맞춰 넓힌다
        const fixed = fitBoxToKeypoints(inst)
        if (fixed.changed) fixedBoxes++
        return fixed.inst
      })
      count++
    }

    // 이미 라벨이 있는 이미지를 그냥 덮어쓰면 작업이 날아가므로 먼저 묻는다
    const clashing = Object.keys(imported).filter((id) => (annotations[id] || []).length > 0)
    let mode = 'replace'
    if (clashing.length > 0) {
      const names = clashing.map((id) => images.find((im) => im.id === id)?.name ?? id)
      mode = await ask(
        '이미 라벨이 있는 이미지가 있습니다',
        `${names.slice(0, 8).join('\n')}${names.length > 8 ? `\n… 외 ${names.length - 8}장` : ''}` +
          `\n\n어떻게 할까요?`,
        [
          { label: '취소', value: null },
          { label: '기존 것 유지', value: 'keep' },
          { label: '합치기', value: 'merge' },
          { label: '덮어쓰기', value: 'replace', tone: 'danger' },
        ]
      )
      if (!mode) return
    }

    pushHistory()
    setAnnotations((prev) => {
      const next = { ...prev }
      for (const [id, list] of Object.entries(imported)) {
        const existing = prev[id] || []
        if (mode === 'keep' && existing.length > 0) continue
        next[id] = mode === 'merge' ? [...existing, ...list] : list
      }
      return next
    })
    let msg = `${count}개 이미지의 어노테이션을 불러왔습니다.`
    if (fixedBoxes)
      msg += `\n\n키포인트가 박스를 벗어난 객체 ${fixedBoxes}개는 박스 크기를 키포인트에 맞춰 넓혔습니다.`
    if (skippedImages.length)
      msg += `\n\n업로드된 이미지 중에 없어서 건너뜀: ${skippedImages.slice(0, 5).join(', ')}${skippedImages.length > 5 ? ` 외 ${skippedImages.length - 5}건` : ''}`
    if (unknownKps.size)
      msg += `\n\n현재 프로젝트에 정의되지 않아 무시된 키포인트: ${[...unknownKps].join(', ')}`
    await ask('불러오기 완료', msg, [{ label: '확인', value: null, tone: 'primary' }])
  }

  if (!image) return <div className="center-screen">이미지가 없습니다.</div>

  const pointR = pointSize / scale // 키포인트 반지름
  const strokeW = 1.2 / scale // 바운딩 박스 선 굵기 (화면 기준)
  // 스켈레톤 선 굵기도 포인트 크기에 비례
  const edgeW = Math.max(0.5, pointSize * 0.6) / scale
  // 포인트 크기에 비례해 이름 글씨도 함께 줄어든다
  const fontSize = Math.min(13, pointSize * 2.2) / scale

  return (
    <div className="labeler">
      {/* 왼쪽: 이미지 목록 */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2 title={projectName}>{projectName}</h2>
          <div className="sidebar-meta">
            <SaveBadge state={saveState} />
            <code title={`project/${project.slug}/`}>project/{project.slug}/</code>
          </div>
          <div className="row">
            <button className="btn small" onClick={onBack}>← 목록</button>
            <button className="btn small" onClick={onEditSetup}>스켈레톤 수정</button>
          </div>
          <div className="image-progress muted small">
            {images.findIndex((im) => im.id === image.id) + 1} / {images.length}장
            {' · '}
            완료 {images.filter((im) => isDone(im.id)).length}장
          </div>
          <button
            className="btn small"
            disabled={addingImages}
            onClick={() => fileRef.current.click()}
          >
            {addingImages ? '저장하는 중…' : '+ 이미지 추가'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={async (e) => {
              const files = e.target.files
              e.target.value = ''
              if (!files?.length) return
              setAddingImages(true)
              try {
                addImages(await importImageFiles(project.slug, files))
              } catch (err) {
                notify(`이미지 저장 실패: ${err.message}`, 'error')
              }
              setAddingImages(false)
            }}
          />
        </div>
        <ul className="image-list">
          {images.map((im) => {
            const count = (annotations[im.id] || []).length
            return (
              <li
                key={im.id}
                className={im.id === image.id ? 'active' : ''}
                onClick={() => {
                  setCurrentId(im.id)
                  setSelectedId(null)
                  setSelectedKp(null)
                  setPlacing(null)
                  setView({ z: 1, tx: 0, ty: 0 })
                }}
              >
                <img src={im.url} alt="" />
                <span className="image-name" title={im.name}>{im.name}</span>
                {count > 0 && <span className="badge">{count}</span>}
                <StatusStar
                  state={starState(im.id)}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleDone(im.id)
                  }}
                />
              </li>
            )
          })}
        </ul>
        <button className="btn export" onClick={() => importRef.current.click()}>
          JSON 불러오기
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            if (e.target.files[0]) importJSON(e.target.files[0])
            e.target.value = ''
          }}
        />
        <button className="btn primary" onClick={exportJSON}>
          JSON 내보내기
        </button>
      </aside>

      {/* 가운데: 캔버스 */}
      <main className="canvas-area">
        <div className="canvas-toolbar">
          {placing ? (
            <span className="canvas-hint-text placing-hint">
              포인트 다시 찍기:{' '}
              <b>{keypointDefs.find((d) => d.id === placing.defId)?.name}</b> — 원하는 위치를
              클릭하세요 (Esc = 취소)
            </span>
          ) : (
            <>
              <button className="btn tiny" disabled={!canUndo} onClick={undo}>
                ↶ 되돌리기
              </button>
              <button className="btn tiny" onClick={() => setKeySettingsOpen(true)}>
                단축키
              </button>
            </>
          )}
          <span className="toolbar-spacer" />
          <span className="point-size-control" title="마우스 휠로 확대/축소">
            <span>줌 {Math.round(view.z * 100)}%</span>
            {view.z !== 1 && (
              <button className="btn tiny" onClick={() => setView({ z: 1, tx: 0, ty: 0 })}>
                초기화
              </button>
            )}
          </span>
          <label
            className="point-size-control"
            title="선택한 박스 영역만 밝게 보여주고 다른 객체는 숨깁니다"
          >
            <input
              type="checkbox"
              checked={focusMode}
              onChange={(e) => setFocusMode(e.target.checked)}
            />
            <span>집중 모드</span>
          </label>
          <label className="point-size-control" title="포인트 이름 표시 방식">
            <span>이름</span>
            <select
              className="label-mode-select"
              value={labelMode}
              onChange={(e) => setLabelMode(e.target.value)}
            >
              <option value="all">항상 표시</option>
              <option value="selected">선택한 포인트만</option>
              <option value="none">숨김</option>
            </select>
          </label>
          <label className="point-size-control" title="키포인트 표시 크기">
            <span>포인트 크기</span>
            <input
              type="range"
              min="1"
              max="10"
              step="0.5"
              value={pointSize}
              onChange={(e) => setPointSize(Number(e.target.value))}
            />
            <span className="point-size-value">{pointSize}px</span>
          </label>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <div className="canvas-wrap" ref={wrapRef}>
          <div
            className="image-holder"
            ref={holderRef}
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`,
              transformOrigin: '0 0',
            }}
          >
            <img ref={imgRef} src={image.url} alt={image.name} draggable={false} />
            <svg
              ref={svgRef}
              className={dupKeyDown ? 'dup-mode' : undefined}
              viewBox={`0 0 ${image.width} ${image.height}`}
              style={spacePan ? { cursor: 'grab' } : undefined}
              onPointerDown={startDrawBox}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {focusOn && (
                <>
                  <defs>
                    <mask id="focus-mask">
                      <rect x="0" y="0" width={image.width} height={image.height} fill="#fff" />
                      <rect
                        x={focusRect.x}
                        y={focusRect.y}
                        width={focusRect.w}
                        height={focusRect.h}
                        fill="#000"
                      />
                    </mask>
                  </defs>
                  <rect
                    className="focus-dim"
                    x="0"
                    y="0"
                    width={image.width}
                    height={image.height}
                    mask="url(#focus-mask)"
                  />
                </>
              )}
              {visibleInstances.map((inst) => (
                <g key={inst.id}>
                  <rect
                    className={`bbox ${inst.id === selectedId ? 'selected' : ''} ${
                      inst.locked ? 'locked' : ''
                    }`}
                    x={inst.x}
                    y={inst.y}
                    width={inst.w}
                    height={inst.h}
                    strokeWidth={strokeW}
                    onPointerDown={(e) => startMoveBox(e, inst)}
                  />
                  {edges.map(([a, b]) => {
                    const ka = inst.keypoints.find((k) => k.defId === a)
                    const kb = inst.keypoints.find((k) => k.defId === b)
                    // 한쪽이라도 v=0(좌표 없음)이면 선을 그리지 않음
                    if (!ka || !kb || ka.v === 0 || kb.v === 0 || ka.x == null || kb.x == null)
                      return null
                    const occluded = ka.v === 1 || kb.v === 1
                    return (
                      <line
                        key={`${a}-${b}`}
                        className="skeleton-edge"
                        x1={ka.x}
                        y1={ka.y}
                        x2={kb.x}
                        y2={kb.y}
                        strokeWidth={edgeW}
                        strokeDasharray={occluded ? `${5 / scale} ${4 / scale}` : undefined}
                      />
                    )
                  })}
                  {inst.keypoints.map((k) => {
                    if (k.v === 0 || k.x == null) return null // v=0은 캔버스에 그리지 않음
                    const def = keypointDefs.find((d) => d.id === k.defId)
                    const isSel =
                      selectedKp?.instId === inst.id && selectedKp?.defId === k.defId
                    return (
                      <g key={k.defId}>
                        {/* 포인트가 작아도 잡기 쉽게 투명한 히트 영역을 겹침 */}
                        <circle
                          className="keypoint-hit"
                          cx={k.x}
                          cy={k.y}
                          r={Math.max(pointR, 8 / scale)}
                          onPointerDown={(e) => startMovePoint(e, inst, k.defId)}
                        />
                        {k.v === 2 ? (
                          <circle
                            className="keypoint"
                            cx={k.x}
                            cy={k.y}
                            r={pointR}
                            fill={def.color}
                            onPointerDown={(e) => startMovePoint(e, inst, k.defId)}
                          />
                        ) : (
                          // v=1 가려짐: 속이 빈 원
                          <circle
                            className="keypoint occluded"
                            cx={k.x}
                            cy={k.y}
                            r={pointR}
                            fill="none"
                            stroke={def.color}
                            strokeWidth={Math.max(1.5 / scale, pointR * 0.35)}
                            onPointerDown={(e) => startMovePoint(e, inst, k.defId)}
                          />
                        )}
                        {(labelMode === 'all' || (labelMode === 'selected' && isSel)) && (
                          <text
                            className="kp-label"
                            x={k.x + pointR * 1.4 + 2 / scale}
                            y={k.y - pointR * 0.8 - 2 / scale}
                            fontSize={fontSize}
                            fill={def.color}
                          >
                            {def.name}
                          </text>
                        )}
                      </g>
                    )
                  })}
                  {/* 선택된 박스: 가장자리/모서리에 보이지 않는 크기 조절 영역 */}
                  {inst.id === selectedId &&
                    !inst.locked &&
                    (() => {
                      const t = 10 / scale // 변 히트 영역 두께
                      const c = 14 / scale // 모서리 히트 영역 크기
                      const zones = [
                        ['n', inst.x + c / 2, inst.y - t / 2, Math.max(0, inst.w - c), t, 'ns-resize'],
                        ['s', inst.x + c / 2, inst.y + inst.h - t / 2, Math.max(0, inst.w - c), t, 'ns-resize'],
                        ['w', inst.x - t / 2, inst.y + c / 2, t, Math.max(0, inst.h - c), 'ew-resize'],
                        ['e', inst.x + inst.w - t / 2, inst.y + c / 2, t, Math.max(0, inst.h - c), 'ew-resize'],
                        ['nw', inst.x - c / 2, inst.y - c / 2, c, c, 'nwse-resize'],
                        ['ne', inst.x + inst.w - c / 2, inst.y - c / 2, c, c, 'nesw-resize'],
                        ['sw', inst.x - c / 2, inst.y + inst.h - c / 2, c, c, 'nesw-resize'],
                        ['se', inst.x + inst.w - c / 2, inst.y + inst.h - c / 2, c, c, 'nwse-resize'],
                      ]
                      return zones.map(([name, zx, zy, zw, zh, cursorStyle]) => (
                        <rect
                          key={name}
                          x={zx}
                          y={zy}
                          width={zw}
                          height={zh}
                          fill="transparent"
                          style={{ cursor: cursorStyle }}
                          onPointerDown={(e) => startResize(e, inst, name)}
                        />
                      ))
                    })()}
                </g>
              ))}
              {draft && (
                <rect
                  className="bbox draft"
                  x={draft.x}
                  y={draft.y}
                  width={draft.w}
                  height={draft.h}
                  strokeWidth={strokeW}
                />
              )}
            </svg>
          </div>
        </div>
      </main>

      {/* 오른쪽: 키포인트 범례 + 인스턴스 목록 */}
      <aside className="rightbar">
        <h3>기준 스켈레톤</h3>
        <svg className="tpl-preview" viewBox="0 0 400 400">
          {edges.map(([a, b]) => {
            const pa = keypointDefs.find((d) => d.id === a)
            const pb = keypointDefs.find((d) => d.id === b)
            if (!pa || !pb) return null
            return (
              <line
                key={`${a}-${b}`}
                className="skeleton-edge"
                x1={pa.tx}
                y1={pa.ty}
                x2={pb.tx}
                y2={pb.ty}
                strokeWidth={3}
              />
            )
          })}
          {keypointDefs.map((d) => (
            <circle key={d.id} cx={d.tx} cy={d.ty} r={9} fill={d.color} stroke="#fff" strokeWidth={2} />
          ))}
        </svg>
        <ul className="legend">
          {keypointDefs.map((d, i) => (
            <li key={d.id}>
              <span className="kp-dot" style={{ background: d.color }} />
              {i + 1}. {d.name}
            </li>
          ))}
        </ul>
        {(() => {
          const selInst = instances.find((i) => i.id === selectedId)
          if (!selInst) return null
          return (
            <>
              <h3>선택된 객체의 키포인트</h3>
              <ul className="kp-status-list">
                {selInst.keypoints.map((k) => {
                  const def = keypointDefs.find((d) => d.id === k.defId)
                  const isSel =
                    selectedKp?.instId === selInst.id && selectedKp?.defId === k.defId
                  return (
                    <li
                      key={k.defId}
                      className={isSel ? 'active' : ''}
                      onClick={() => setSelectedKp({ instId: selInst.id, defId: k.defId })}
                    >
                      <span className="kp-dot" style={{ background: def.color }} />
                      <span className="kp-status-name">{def.name}</span>
                      {k.v === 0 && (
                        <button
                          className="btn tiny"
                          title="캔버스를 클릭해 이 포인트를 다시 찍습니다"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPlacing({ instId: selInst.id, defId: k.defId })
                          }}
                        >
                          찍기
                        </button>
                      )}
                      <button
                        className={`v-badge v${k.v}`}
                        title="클릭하면 보임 → 가려짐 → 없음 순환"
                        onClick={(e) => {
                          e.stopPropagation()
                          cycleKpV(selInst.id, k.defId)
                        }}
                      >
                        {k.v} {V_LABELS[k.v]}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )
        })()}
        <h3>이 이미지의 객체 ({instances.length})</h3>
        <ul className="instance-list">
          {instances.map((inst, i) => (
            <li
              key={inst.id}
              className={inst.id === selectedId ? 'active' : ''}
              onClick={() => setSelectedId(inst.id)}
            >
              <span>객체 {i + 1}</span>
              <button
                className={`btn tiny ${inst.locked ? 'locked-on' : ''}`}
                title="박스 고정/해제 (Tab)"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleLock(inst.id)
                }}
              >
                {inst.locked ? '고정됨' : '고정'}
              </button>
              <button
                className="btn tiny danger"
                onClick={(e) => {
                  e.stopPropagation()
                  pushHistory()
                  setInstances((cur) => cur.filter((x) => x.id !== inst.id))
                  if (selectedId === inst.id) setSelectedId(null)
                }}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {dialogNode}
      {keySettingsOpen && (
        <KeySettings
          keymap={keymap}
          onChange={(next) => {
            setKeymap(next)
            saveKeymap(next)
          }}
          onClose={() => setKeySettingsOpen(false)}
        />
      )}
    </div>
  )
}
