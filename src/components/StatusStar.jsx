const TITLES = [
  '미시작 — 클릭하면 완료로 표시',
  '작업중 (라벨이 있음) — 클릭하면 완료로 표시',
  '완료 — 클릭하면 완료 표시를 해제',
]

// 0 빈 별(라벨 없음) · 1 반 별(라벨이 있으면 자동) · 2 꽉 찬 노란 별(사람이 완료로 표시)
export default function StatusStar({ state = 0, onClick }) {
  const path = 'M8 1.6l1.9 4 4.4.6-3.2 3 .8 4.3L8 11.5 3.9 13.5l.8-4.3-3.2-3 4.4-.6z'
  return (
    <button
      className={`status-star s${state}`}
      title={TITLES[state]}
      onClick={onClick}
      aria-label={TITLES[state]}
    >
      <svg viewBox="0 0 16 16" width="14" height="14">
        <defs>
          <linearGradient id="half-star">
            <stop offset="50%" stopColor="currentColor" />
            <stop offset="50%" stopColor="transparent" />
          </linearGradient>
        </defs>
        <path
          d={path}
          fill={state === 2 ? 'currentColor' : state === 1 ? 'url(#half-star)' : 'none'}
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
