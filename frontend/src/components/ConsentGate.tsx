// ログインしたあと、今の版の規約にまだ同意していなければ、画面の代わりに同意の画面を出す。
// ページは移動しないので、QR から来た人（交換・共同フィールドの参加）も同意したらそのまま元の画面に進む
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import { hasConsented, markConsented, subscribeConsent } from './consent.ts'

/** 同意の画面を出しているかどうか。TabLayout はこれを見てタブを隠す */
// eslint-disable-next-line react/only-export-components
export function useNeedsConsent(): boolean {
  const auth = useAuth()
  const did = auth.status === 'signedIn' ? auth.did : undefined
  return useSyncExternalStore(subscribeConsent, () => did !== undefined && !hasConsented(did))
}

export default function ConsentGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const needsConsent = useNeedsConsent()
  const [checked, setChecked] = useState(false)

  if (!needsConsent || auth.status !== 'signedIn') return <>{children}</>

  return (
    <div className="consent">
      <div className="back-header">
        <h1>はじめに</h1>
      </div>
      <div className="card consent-card">
        <p className="consent-lead">
          Pikkles で作ったピクルスや交換の記録は、あなたの PDS に誰でも読める形で保存されます。削除しても、他のサービスに渡ったコピーは消せません。
        </p>
        <ul className="consent-links">
          <li>
            <Link to="/terms" target="_blank" rel="noopener">
              利用規約
            </Link>
          </li>
          <li>
            <Link to="/privacy" target="_blank" rel="noopener">
              プライバシーポリシー
            </Link>
          </li>
        </ul>
      </div>
      <label className="consent-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        利用規約とプライバシーポリシーを読み、同意します
      </label>
      <button
        type="button"
        className="btn btn-primary btn-block account-action"
        disabled={!checked}
        onClick={() => markConsented(auth.did)}
      >
        同意してはじめる
      </button>
      <button type="button" className="btn btn-block account-action" onClick={() => void auth.signOut()}>
        同意しないでログアウト
      </button>
    </div>
  )
}
