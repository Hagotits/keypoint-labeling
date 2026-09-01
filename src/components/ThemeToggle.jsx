const SUN =
  'M12 4.2V2M12 22v-2.2M19.8 12H22M2 12h2.2M17.5 17.5l1.6 1.6M4.9 4.9l1.6 1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6'

export default function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark'
  return (
    <button
      className="icon-btn"
      onClick={onToggle}
      title={dark ? '화이트 모드로 전환' : '블랙 모드로 전환'}
      aria-label={dark ? '화이트 모드로 전환' : '블랙 모드로 전환'}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round">
        {dark ? (
          // 달: 지금 블랙 모드
          <path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4.2" />
            <path d={SUN} />
          </>
        )}
      </svg>
    </button>
  )
}
