import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import Avatar from '../components/Avatar.tsx'
import Loading from '../components/Loading.tsx'
import PageHeader from '../components/PageHeader.tsx'

export default function Login() {
  const auth = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  if (auth.status === 'loading') return <Loading />

  if (auth.status === 'signedIn') {
    return (
      <>
        <PageHeader title="アカウント" />
        <div className="card account-card">
          <Avatar did={auth.did} size={48} />
          <div className="account-names">
            <p className="account-handle">@{auth.handle}</p>
            <p className="text-muted account-did">{auth.did}</p>
          </div>
        </div>
        <p className="text-muted account-note">ログインしています</p>
        <Link to="/" className="btn btn-primary btn-block account-action">
          タイムラインへ
        </Link>
        <button type="button" className="btn btn-block account-action" onClick={() => auth.signOut()}>
          ログアウト
        </button>
      </>
    )
  }

  async function signIn(input: string) {
    setSubmitting(true)
    setError(undefined)
    try {
      await auth.signIn(input)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="login">
      <h1 className="login-logo">
        <img src="/images/logo.png" alt="" width={81} height={81} />
        Pikkles
      </h1>
      <p className="login-tagline">dip, pick, share.</p>
      <p className="login-lead">
        あなたの思い出がステッカーに。
        <br />
        交換したステッカーを、
        <br />
        互いのスマホに残していつまでも。
      </p>
      <div className="login-stickers" aria-hidden="true">
        <img src="/images/login-sticker-1.png" alt="" width={145} height={145} />
        <img src="/images/login-sticker-2.png" alt="" width={149} height={150} />
      </div>
      {/* IDとパスワードは bsky.social の認可画面で入れてもらう */}
      <div className="login-form">
        <button
          type="button"
          className="login-primary"
          disabled={submitting}
          onClick={() => void signIn('https://bsky.social')}
        >
          Blueskyでログイン
        </button>
        {(error ?? auth.error) && (
          <p role="alert" className="login-error">
            {error ?? auth.error}
          </p>
        )}
      </div>
    </div>
  )
}
