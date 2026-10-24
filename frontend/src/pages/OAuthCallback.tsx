import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'

// ログイン前に開いていた画面（交換の参加 URL など）。ExchangeJoin.tsx が入れる
const RETURN_TO_KEY = 'pikkles:returnTo'

function readReturnTo(): string | undefined {
  try {
    const value = sessionStorage.getItem(RETURN_TO_KEY)
    // 同じサイトの中のパスだけ
    return value?.startsWith('/') && !value.startsWith('//') ? value : undefined
  } catch {
    return undefined
  }
}

/** OAuth のコールバック。処理は AuthProvider の init がするので、終わるまで待って移るだけ */
export default function OAuthCallback() {
  const auth = useAuth()
  const returnTo = readReturnTo()

  // StrictMode で描画が2回走っても消えないよう、読むのは描画中、消すのはログインが済んでから
  useEffect(() => {
    if (auth.status !== 'signedIn') return
    try {
      sessionStorage.removeItem(RETURN_TO_KEY)
    } catch {
      // 消せなくても困らない
    }
  }, [auth.status])

  if (auth.status === 'loading') return <p>ログイン中…</p>
  if (auth.status === 'signedIn' && returnTo) return <Navigate to={returnTo} replace />
  // 今は DID・ハンドルを確かめるために S1 に戻す。タイムラインができたら '/' にする
  return <Navigate to="/login" replace />
}
