// 화이트/블랙 모드. 처음 열 때는 OS 설정을 따르고, 한 번 고르면 그 선택을 기억한다.
const STORAGE_KEY = 'keypoint-labeler:theme'

const systemTheme = () =>
  window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'

export function loadTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // 저장소를 못 읽어도 시스템 설정으로 동작한다
  }
  return systemTheme()
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 저장이 막혀도 이번 세션에는 적용된다
  }
}
