import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'

/** OAuth のコールバック。処理は AuthProvider の init がするので、終わるまで待って移るだけ */
export default function OAuthCallback() {
  const auth = useAuth()
  if (auth.status === 'loading') return <p>ログイン中…</p>
  // 今は DID・ハンドルを確かめるために S1 に戻す。タイムラインができたら '/' にする
  return <Navigate to="/login" replace />
}
