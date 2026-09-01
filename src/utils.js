import { uploadImage } from './api'

export const KP_COLORS = [
  '#ff5252', '#ffb300', '#ffee58', '#9ccc65', '#26c6da',
  '#42a5f5', '#7e57c2', '#ec407a', '#26a69a', '#d4e157',
  '#ff7043', '#8d6e63', '#78909c', '#ab47bc', '#66bb6a',
]

let nextId = 1
export const uid = () => `id_${nextId++}_${Date.now().toString(36)}`

// 파일 목록에서 이미지 파일만 골라 크기를 읽는다 → {file, name, width, height}
function readImageFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'))
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          const url = URL.createObjectURL(file)
          const img = new Image()
          img.onload = () => {
            URL.revokeObjectURL(url)
            resolve({
              file,
              name: file.webkitRelativePath || file.name,
              width: img.naturalWidth,
              height: img.naturalHeight,
            })
          }
          img.onerror = () => {
            URL.revokeObjectURL(url)
            resolve(null)
          }
          img.src = url
        })
    )
  ).then((results) => results.filter(Boolean))
}

// 이미지를 project/<slug>/images/ 에 저장하고 화면에서 쓸 형태로 돌려준다.
// id는 저장된 파일 이름 — 새로고침 후에도 어노테이션이 같은 이미지에 붙는다.
export async function importImageFiles(slug, fileList) {
  const loaded = await readImageFiles(fileList)
  const out = []
  for (const item of loaded) {
    const saved = await uploadImage(slug, item.file, item.name)
    out.push({
      id: saved.file,
      name: saved.file,
      url: saved.url,
      width: item.width,
      height: item.height,
    })
  }
  return out
}

// 좌우 반전 시 짝을 이루는 키포인트를 이름으로 찾는다.
// left_wing_tip ↔ right_wing_tip, wing_l ↔ wing_r 같은 이름 규칙을 지원한다.
export function buildFlipPairs(keypointDefs) {
  const byName = new Map(keypointDefs.map((d) => [d.name.toLowerCase(), d.id]))
  const counterpart = (name) => {
    const n = name.toLowerCase()
    if (n.includes('left')) return n.replace('left', 'right')
    if (n.includes('right')) return n.replace('right', 'left')
    if (/^l[_-]/.test(n)) return n.replace(/^l([_-])/, 'r$1')
    if (/^r[_-]/.test(n)) return n.replace(/^r([_-])/, 'l$1')
    if (/[_-]l$/.test(n)) return n.replace(/([_-])l$/, '$1r')
    if (/[_-]r$/.test(n)) return n.replace(/([_-])r$/, '$1l')
    return null
  }

  const pairs = {}
  for (const d of keypointDefs) {
    const other = counterpart(d.name)
    const otherId = other && byName.get(other)
    if (otherId && otherId !== d.id) pairs[d.id] = otherId
  }
  return pairs
}

// 박스를 뒤집었을 때 키포인트를 새 박스에 맞춰 옮긴다.
// 한 축만 뒤집으면 좌우가 바뀌므로 left/right 짝의 라벨도 서로 맞바꾼다.
// (두 축 모두 뒤집으면 180도 회전이라 짝은 그대로 둔다.)
export function mirrorKeypoints(keypoints, origBox, newBox, flipX, flipY, pairs) {
  const o = origBox
  const moved = keypoints.map((k) => {
    if (k.x == null || k.y == null) return { ...k }
    const rx = o.w === 0 ? 0.5 : (k.x - o.x) / o.w
    const ry = o.h === 0 ? 0.5 : (k.y - o.y) / o.h
    return {
      ...k,
      x: newBox.x + (flipX ? 1 - rx : rx) * newBox.w,
      y: newBox.y + (flipY ? 1 - ry : ry) * newBox.h,
    }
  })

  if (flipX === flipY) return moved // 반전 없음 또는 180도 회전
  const by = Object.fromEntries(moved.map((k) => [k.defId, k]))
  return moved.map((k) => {
    const src = by[pairs[k.defId]]
    return src ? { ...k, x: src.x, y: src.y, v: src.v } : k
  })
}
