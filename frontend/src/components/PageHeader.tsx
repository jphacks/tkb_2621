// タブの画面の上に出す、ロゴと画面名。ログインしていれば右端に自分のアイコンを置き、アカウントへの入口にする
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import { ProfileAvatar } from './Profile.tsx'

export default function PageHeader({ title }: { title: string }) {
  const auth = useAuth()
  return (
    <header className="page-header">
      <span className="page-header-logo">
        <img src="/images/logo.png" alt="" width={55} height={55} />
        Pikkles
      </span>
      <div className="page-header-end">
        <h1 className="page-header-title">{title}</h1>
        {auth.status === 'signedIn' && (
          <Link to="/account" className="page-header-account" aria-label="アカウント">
            <ProfileAvatar did={auth.did} size={32} />
          </Link>
        )}
      </div>
    </header>
  )
}
