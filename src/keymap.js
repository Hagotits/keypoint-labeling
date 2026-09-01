// 라벨링 단축키. 사람마다 손에 맞는 키가 달라서 브라우저(localStorage)에 저장한다.
// 프로젝트 데이터가 아니라 개인 설정이므로 project.json에는 넣지 않는다.

const STORAGE_KEY = 'keypoint-labeler:keymap'

// 맥은 ⌘, 윈도우/리눅스는 Ctrl
export const MOD = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'

// 바꿀 수 있는 동작들
export const KEY_ACTIONS = [
  { id: 'visible', label: '가시성 → 2 보임', keys: ['2'] },
  { id: 'occluded', label: '가시성 → 1 가려짐', keys: ['1'] },
  { id: 'absent', label: '가시성 → 0 없음', keys: ['0'] },
  { id: 'cycle', label: '가시성 순환 (2 → 1 → 0)', keys: ['v'] },
  { id: 'lock', label: '박스 고정 / 해제', keys: ['Tab'] },
  { id: 'remove', label: '포인트 v=0 / 박스 삭제', keys: ['Delete', 'Backspace'] },
  { id: 'undo', label: `되돌리기 (${MOD} + Z 로도 됨)`, keys: ['z'] },
  { id: 'duplicate', label: '박스 복사 (누른 채 드래그)', keys: ['a'] },
  { id: 'copy', label: '복사', keys: ['s'] },
  { id: 'paste', label: '붙여넣기', keys: ['d'] },
  { id: 'prevImage', label: '이전 이미지', keys: ['ArrowLeft', 'ArrowUp'] },
  { id: 'nextImage', label: '다음 이미지', keys: ['ArrowRight', 'ArrowDown', 'Enter'] },
]

// 못 바꾸는 것들 (설정 창에서 참고용으로만 보여줌)
export const FIXED_SHORTCUTS = [
  ['드래그', '박스 그리기 (시작 지점이 스켈레톤 위쪽)'],
  ['휠', '확대 / 축소'],
  ['Space + 드래그, 휠버튼 드래그', '화면 이동'],
  ['Esc', '선택 해제 / 다시 찍기 취소'],
  [`${MOD} + Z`, '되돌리기 (위의 되돌리기 키와 별개로 항상 동작)'],
]

export const DEFAULT_KEYMAP = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a.keys]))

// 저장 형식으로 정규화: 알파벳 한 글자는 소문자, 스페이스는 'Space'
export function normalizeKey(key) {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toLowerCase() : key
}

export function loadKeymap() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    // 저장된 값에 없는 동작은 기본값으로 채운다 (동작이 추가돼도 깨지지 않게)
    return Object.fromEntries(
      KEY_ACTIONS.map((a) => [
        a.id,
        Array.isArray(saved[a.id]) && saved[a.id].length ? saved[a.id] : a.keys,
      ])
    )
  } catch {
    return { ...DEFAULT_KEYMAP }
  }
}

export function saveKeymap(keymap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap))
  } catch {
    // 시크릿 모드 등에서 저장이 막혀도 이번 세션에서는 그대로 동작한다
  }
}

// 이벤트가 해당 동작의 키인지. 수정키가 눌린 조합은 별도 처리하므로 여기서 제외한다.
export function matches(keymap, actionId, e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  return (keymap[actionId] || []).includes(normalizeKey(e.key))
}

const LABELS = {
  Space: 'Space',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '⏎',
}

// ⌘/Ctrl + Z 는 설정과 무관하게 항상 되돌리기로 동작한다 (익숙한 조합이라 손이 먼저 감)
export const isUndoCombo = (e) =>
  (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z'

export const keyLabel = (k) => LABELS[k] ?? (k.length === 1 ? k.toUpperCase() : k)
