// 共同フィールドへの招待。iPhone のカメラで招待 QR を読むと Safari でこの URL（/fields/join?code=…）が開く。
// 一覧で招待コードを手で入れたときも同じ URL を開く。コードは10分で失効する。
// 前の形（?uri=…&cid=…）はすでにメンバーの人の参加し直しにだけ使える。
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BackendError, joinField, lookupFieldInvite } from '../api/backend.ts'
import { fieldPath, getField, normalizeInviteCode, writeMember, type FieldView } from '../api/field.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import Loading from '../components/Loading.tsx'

// OAuthCallback.tsx と同じキー。ログインのあとにこの URL へ戻る
const RETURN_TO_KEY = 'pikkles:returnTo'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 403（コードが違う・期限切れ・ブロック）と 429（間違えすぎ）はサーバーの文をそのまま出す */
function joinErrorMessage(e: unknown): string {
  if (e instanceof BackendError && e.status === 410) return 'このフィールドは削除されました'
  if (e instanceof BackendError && (e.status === 403 || e.status === 429)) return e.message
  return `参加できませんでした：${errorMessage(e)}`
}

export default function FieldJoin() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const code = normalizeInviteCode(searchParams.get('code') ?? '') || undefined
  const uri = searchParams.get('uri')
  const cid = searchParams.get('cid')
  const agent = auth.status === 'signedIn' ? auth.agent : undefined

  const [field, setField] = useState<FieldView>()
  const [loadError, setLoadError] = useState<string>()
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string>()

  useEffect(() => {
    if (code ? !agent : !uri || !cid) return
    let cancelled = false
    // コードからどのフィールドかを引く（引けなければ 403）
    const ref = code && agent ? lookupFieldInvite(agent, code).then((r) => r.field.uri) : Promise.resolve(uri ?? '')
    ref
      .then((u) => getField(u))
      .then((f) => !cancelled && setField(f))
      .catch((e: unknown) => !cancelled && setLoadError(code ? joinErrorMessage(e) : errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, code, uri, cid])

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut') {
    try {
      sessionStorage.setItem(RETURN_TO_KEY, location.pathname + location.search)
    } catch {
      // 保存できなければログイン後は既定の画面に戻る
    }
    return <Navigate to="/login" replace />
  }

  const { agent: signedInAgent, did } = auth
  const error = !code && (!uri || !cid) ? 'URL が正しくありません。QR を読み直してください' : loadError

  async function onJoin() {
    if (!field) return
    setJoining(true)
    setJoinError(undefined)
    try {
      // サーバーで断られたのに自分の PDS だけ参加中にならないように、サーバーが通ってから書く
      await joinField(signedInAgent, field.ref, code)
      await writeMember(signedInAgent, did, field.ref)
      navigate(fieldPath(field.ref), { replace: true })
    } catch (e) {
      setJoinError(joinErrorMessage(e))
      setJoining(false)
    }
  }

  return (
    <>
      <h1 className="field-list-title">共同フィールドへの招待</h1>
      {error ? (
        <>
          <p role="alert" className="notice">
            {error}
          </p>
          <Link to="/fields" className="btn btn-primary btn-block account-action">
            共同フィールド一覧へ
          </Link>
        </>
      ) : !field ? (
        <Loading />
      ) : (
        <>
          <div className="card field-card field-invite-card">
            <span className="field-card-thumb" aria-hidden="true" />
            <span className="field-card-title">{field.title}</span>
          </div>
          <p className="field-invite-text">
            「{field.title}」に招待されています。
            <br />
            参加すると、自分のピクルスをここに貼れます。
          </p>
          <button type="button" className="btn btn-primary btn-block" onClick={onJoin} disabled={joining}>
            {joining ? '参加しています…' : '参加する'}
          </button>
          {joining && <BackendWaking />}
          {joinError && (
            <p role="alert" className="notice field-invite-error">
              {joinError}
            </p>
          )}
        </>
      )}
    </>
  )
}
