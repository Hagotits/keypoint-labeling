const TEXT = {
  idle: '자동 저장',
  saving: '저장 중…',
  saved: '저장됨',
  error: '저장 실패',
}

export default function SaveBadge({ state = 'idle' }) {
  return <span className={`save-badge ${state}`}>{TEXT[state] ?? TEXT.idle}</span>
}
