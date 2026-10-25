// アカウント。ヘッダー右上の自分のアイコンから開く。使い方・ログアウト・規約へ行く入口
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import { ProfileAvatar } from '../components/Profile.tsx'
import Loading from '../components/Loading.tsx'

export default function Account() {
  const auth = useAuth()
  const navigate = useNavigate()

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  async function signOut() {
    if (!window.confirm('ログアウトしますか？')) return
    await auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <>
      <div className="card account-card">
        <ProfileAvatar did={auth.did} size={48} />
        <div className="account-names">
          <p className="account-handle">@{auth.handle}</p>
          <p className="text-muted account-did">{auth.did}</p>
        </div>
      </div>
      <p className="text-muted account-note">ログインしています</p>
      <Link to="/tutorial" className="btn btn-block account-action">
        使い方を見る
      </Link>
      <button type="button" className="btn btn-block account-action" onClick={() => void signOut()}>
        ログアウト
      </button>
      <p className="account-legal">
        <Link to="/terms">利用規約</Link>
        <Link to="/privacy">プライバシーポリシー</Link>
      </p>
    </>
  )
}
