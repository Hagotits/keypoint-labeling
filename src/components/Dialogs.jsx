import { useCallback, useRef, useState } from 'react'

// alert/confirm은 브라우저 전체를 멈추고 작업 흐름을 끊어서 쓰지 않는다.
// 대신 화면 안 토스트 + 모달로 처리한다.

export function useDialogs() {
  const [toast, setToast] = useState(null) // {text, tone}
  const [dialog, setDialog] = useState(null) // {title, message, buttons, resolve}
  const timerRef = useRef(null)

  const notify = useCallback((text, tone = 'info', ms = 4000) => {
    clearTimeout(timerRef.current)
    setToast({ text, tone })
    timerRef.current = setTimeout(() => setToast(null), ms)
  }, [])

  // ask(...) → 누른 버튼의 value로 resolve되는 Promise
  const ask = useCallback(
    (title, message, buttons) =>
      new Promise((resolve) => setDialog({ title, message, buttons, resolve })),
    []
  )

  const answer = (value) => {
    dialog?.resolve(value)
    setDialog(null)
  }

  const node = (
    <>
      {toast && (
        <div className={`toast ${toast.tone}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
      {dialog && (
        <div className="modal-backdrop" onPointerDown={() => answer(null)}>
          <div className="modal-card narrow" onPointerDown={(e) => e.stopPropagation()}>
            <h2>{dialog.title}</h2>
            {dialog.message && <pre className="dialog-message">{dialog.message}</pre>}
            <div className="row dialog-buttons">
              {dialog.buttons.map((b) => (
                <button
                  key={b.label}
                  className={`btn ${b.tone || ''}`}
                  onClick={() => answer(b.value)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )

  return { notify, ask, dialogNode: node, dialogOpen: !!dialog }
}
