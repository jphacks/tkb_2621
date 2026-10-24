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

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const input = handle.trim().replace(/^@/, '')
    if (!input) return
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
    <>
      <h1>Pikkles</h1>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="example.bsky.social"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
        />
        <button type="submit" disabled={submitting}>
          Blueskyでログイン
        </button>
      </form>
      {(error ?? auth.error) && <p role="alert">{error ?? auth.error}</p>}
    </>
  )
}
