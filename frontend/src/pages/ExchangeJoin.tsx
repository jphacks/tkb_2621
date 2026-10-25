// S5 対面交換：参加する側（B）。iPhone のカメラで QR を読むと Safari でこの URL（/exchange/join/:sessionId?t=…）が開く。
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { BackendError, joinSession } from '../api/backend.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import ExchangeRoom from '../components/ExchangeRoom.tsx'

// OAuthCallback.tsx と同じキー。ログインのあとにこの URL へ戻る
const RETURN_TO_KEY = 'pikkles:returnTo'

type JoinState = { kind: 'joining' } | { kind: 'error'; message: string } | { kind: 'joined'; occasion: string | null }

function joinErrorMessage(e: unknown): string {
  if (e instanceof BackendError) {
    if (e.status === 410) return 'QR の有効期限が切れています。QR を読み直してください'
    if (e.status === 403) return 'この相手とは交換できません'
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

export default function ExchangeJoin() {
  const auth = useAuth()
  const location = useLocation()
  const { sessionId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const t = searchParams.get('t')
  const [joinState, setJoinState] = useState<JoinState>({ kind: 'joining' })
  const state: JoinState = t ? joinState : { kind: 'error', message: 'URL が正しくありません。QR を読み直してください' }
  const agent = auth.status === 'signedIn' ? auth.agent : undefined

  useEffect(() => {
    if (!agent || !t) return
    let cancelled = false
    joinSession(agent, sessionId, t)
      .then((res) => !cancelled && setJoinState({ kind: 'joined', occasion: res.occasion }))
      .catch((e: unknown) => !cancelled && setJoinState({ kind: 'error', message: joinErrorMessage(e) }))
    return () => {
      cancelled = true
    }
  }, [agent, sessionId, t])

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') {
    try {
      sessionStorage.setItem(RETURN_TO_KEY, location.pathname + location.search)
    } catch {
      // 保存できなければログイン後は既定の画面に戻る
    }
    return <Navigate to="/login" replace />
  }

  if (state.kind === 'error') {
    return (
      <>
        <div className="back-header">
          <h1>対面で交換</h1>
        </div>
        <p role="alert" className="notice exchange-notice">
          {state.message}
        </p>
        <Link to="/" className="btn btn-primary btn-block exchange-bottom">
          ホームへ
        </Link>
      </>
    )
  }

  if (state.kind === 'joining') {
    return (
      <>
        <div className="back-header">
          <h1>対面で交換</h1>
        </div>
        <BackendWaking />
        <p role="status" className="exchange-progress">
          参加しています…
        </p>
      </>
    )
  }

  return (
    <>
      <BackendWaking />
      <ExchangeRoom
        agent={auth.agent}
        did={auth.did}
        sessionId={sessionId}
        occasion={state.occasion}
        partnerJoined
      />
    </>
  )
}
