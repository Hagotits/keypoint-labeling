import { useEffect, useState } from 'react'
import {
  DEFAULT_KEYMAP,
  FIXED_SHORTCUTS,
  KEY_ACTIONS,
  keyLabel,
  normalizeKey,
} from '../keymap'

// 새로 지정할 수 없는 키 (수정키 단독, 브라우저가 가로채는 키)
const BLOCKED = new Set(['Shift', 'Control', 'Alt', 'Meta', 'Escape'])

export default function KeySettings({ keymap, onChange, onClose }) {
  const [capturing, setCapturing] = useState(null) // 키 입력을 기다리는 action id
  const [notice, setNotice] = useState('')

  // 설정 창이 열려 있는 동안의 키 입력은 전부 여기서 처리한다
  useEffect(() => {
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        // 키 입력 대기 중이면 그것만 취소, 아니면 창을 닫는다
        if (capturing) setCapturing(null)
        else onClose()
        return
      }
      if (!capturing || BLOCKED.has(e.key)) return

      const key = normalizeKey(e.key)
      const taken = KEY_ACTIONS.find((a) => a.id !== capturing && keymap[a.id]?.includes(key))
      const next = { ...keymap, [capturing]: [key] }
      // 다른 동작이 쓰던 키면 그쪽에서 떼어낸다 (한 키가 두 동작을 하지 않게)
      if (taken) {
        next[taken.id] = keymap[taken.id].filter((k) => k !== key)
        if (next[taken.id].length === 0) next[taken.id] = []
        setNotice(`'${keyLabel(key)}' 키를 «${taken.label}»에서 가져왔습니다. 그쪽 키를 다시 지정해 주세요.`)
      } else {
        setNotice('')
      }
      onChange(next)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, keymap, onChange, onClose])

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal-card" onPointerDown={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>단축키</h2>
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="muted small">
          바꾸고 싶은 키를 클릭한 뒤 원하는 키를 누르세요. 이 브라우저에 저장됩니다.
        </p>

        <table className="key-table">
          <tbody>
            {KEY_ACTIONS.map((a) => {
              const keys = keymap[a.id] ?? []
              return (
                <tr key={a.id}>
                  <td>{a.label}</td>
                  <td className="key-cell">
                    <button
                      className={`key-chip ${capturing === a.id ? 'capturing' : ''} ${
                        keys.length === 0 ? 'unset' : ''
                      }`}
                      onClick={() => {
                        setNotice('')
                        setCapturing(capturing === a.id ? null : a.id)
                      }}
                    >
                      {capturing === a.id
                        ? '키를 누르세요…'
                        : keys.length
                          ? keys.map(keyLabel).join(' / ')
                          : '지정 안 됨'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {notice && <p className="error-text">{notice}</p>}

        <div className="row">
          <button
            className="btn"
            onClick={() => {
              onChange({ ...DEFAULT_KEYMAP })
              setCapturing(null)
              setNotice('')
            }}
          >
            기본값으로 되돌리기
          </button>
        </div>

        <h3>바꿀 수 없는 조작</h3>
        <table className="key-table fixed">
          <tbody>
            {FIXED_SHORTCUTS.map(([k, desc]) => (
              <tr key={k}>
                <td className="key-cell">
                  <span className="key-chip static">{k}</span>
                </td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
