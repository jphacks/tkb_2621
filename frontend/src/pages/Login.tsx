import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'

export default function Login() {
  const auth = useAuth()
  const [handle, setHandle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  if (auth.status === 'loading') return <p>読み込み中…</p>

  if (auth.status === 'signedIn') {
    return (
      <>
        <h1>ログイン中</h1>
        <p>ハンドル：@{auth.handle}</p>
        <p>DID：{auth.did}</p>
        <button type="button" onClick={() => auth.signOut()}>
          ログアウト
        </button>
        <p>
          <Link to="/">タイムラインへ</Link>
        </p>
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

  // ハンドルが空なら bsky.social のログイン画面へ、入っていればそのハンドルのサーバーへ
  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const input = handle.trim().replace(/^@/, '')
    void signIn(input || 'https://bsky.social')
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
      <form className="login-form" onSubmit={onSubmit}>
        <input
          type="text"
          className="input login-input"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="example.bsky.social"
          aria-label="ハンドル（空のままなら bsky.social でログイン）"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
        />
        <button type="submit" className="login-primary" disabled={submitting}>
          Blueskyでログイン
        </button>
        {(error ?? auth.error) && (
          <p role="alert" className="login-error">
            {error ?? auth.error}
          </p>
        )}
      </form>
    </div>
  )
}
