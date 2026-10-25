import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import Loading from '../components/Loading.tsx'

function LegalLinks({ className }: { className: string }) {
  return (
    <p className={className}>
      <Link to="/terms">利用規約</Link>
      <Link to="/privacy">プライバシーポリシー</Link>
    </p>
  )
}

export default function Login() {
  const auth = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const [otherOpen, setOtherOpen] = useState(false)
  const [handleInput, setHandleInput] = useState('')

  if (auth.status === 'loading') return <Loading />

  // ログインした状態で開いたらアカウントへ。前はここにアカウントの中身を出していたので、URL はそのまま生かす
  if (auth.status === 'signedIn') return <Navigate to="/account" replace />

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

  // 「@alice.example.com」のように頭に @ を付けて入れる人がいるので外す
  const handle = handleInput.trim().replace(/^@/, '')

  return (
    <div className="login">
      <h1 className="login-logo">
        <img src="/images/logo.png" alt="" width={81} height={81} />
        Pikkles
      </h1>
      <p className="login-tagline">dip, pick, share.</p>
      <p className="login-lead">
        あなたの思い出がピクルスに。
        <br />
        交換したピクルスを、
        <br />
        互いのスマホに残していつまでも。
      </p>
      <div className="login-stickers" aria-hidden="true">
        <img src="/images/login-sticker-1.png" alt="" width={145} height={145} />
        <img src="/images/login-sticker-2.png" alt="" width={149} height={150} />
      </div>
      {/* IDとパスワードは各 PDS の認可画面で入れてもらう。ふだんは bsky.social、それ以外はハンドルから引く */}
      <div className="login-form">
        <button
          type="button"
          className="login-primary"
          disabled={submitting}
          onClick={() => void signIn('https://bsky.social')}
        >
          Blueskyでログイン
        </button>
        {otherOpen ? (
          <form
            className="login-other"
            onSubmit={(e) => {
              e.preventDefault()
              if (handle) void signIn(handle)
            }}
          >
            <input
              type="text"
              className="login-handle"
              placeholder="example.com"
              aria-label="ハンドル"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              spellCheck={false}
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
            />
            <button type="submit" className="login-primary" disabled={submitting || !handle}>
              ログイン
            </button>
          </form>
        ) : (
          <button type="button" className="login-other-toggle" onClick={() => setOtherOpen(true)}>
            bsky.social 以外のアカウントでログイン
          </button>
        )}
        {(error ?? auth.error) && (
          <p role="alert" className="login-error">
            {error ?? auth.error}
          </p>
        )}
        <LegalLinks className="login-legal" />
      </div>
    </div>
  )
}
