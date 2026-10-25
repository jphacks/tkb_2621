// 利用規約・プライバシーポリシーの枠。ログインしていなくても読める
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export default function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()

  // 同意の画面から新しいタブで開いたときは戻る先がないので、トップへ
  function back() {
    if (location.key === 'default') navigate('/', { replace: true })
    else navigate(-1)
  }

  return (
    <article className="legal">
      <div className="back-header">
        <button type="button" className="icon-button" onClick={back} aria-label="もどる">
          <img src="/images/back.svg" alt="" width={13} height={18} />
        </button>
        <h1>{title}</h1>
      </div>
      {children}
    </article>
  )
}
