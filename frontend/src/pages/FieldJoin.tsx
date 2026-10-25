// 共同フィールドへの招待。iPhone のカメラで招待 QR を読むと Safari でこの URL（/fields/join?uri=…&cid=…）が開く。
import { useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BackendError, joinField } from '../api/backend.ts'
import { fieldPath, getField, writeMember, type FieldView } from '../api/field.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import Loading from '../components/Loading.tsx'
import PageHeader from '../components/PageHeader.tsx'

// OAuthCallback.tsx と同じキー。ログインのあとにこの URL へ戻る
const RETURN_TO_KEY = 'pikkles:returnTo'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function FieldJoin() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const uri = searchParams.get('uri')
  const cid = searchParams.get('cid')

  const [field, setField] = useState<FieldView>()
  const [loadError, setLoadError] = useState<string>()
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string>()

  useEffect(() => {
    if (!uri || !cid) return
    let cancelled = false
    getField(uri)
      .then((f) => !cancelled && setField(f))
      .catch((e: unknown) => !cancelled && setLoadError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [uri, cid])

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut') {
    try {
      sessionStorage.setItem(RETURN_TO_KEY, location.pathname + location.search)
    } catch {
      // 保存できなければログイン後は既定の画面に戻る
    }
    return <Navigate to="/login" replace />
  }

  const { agent, did } = auth
  const error = !uri || !cid ? 'URL が正しくありません。QR を読み直してください' : loadError

  async function onJoin() {
    if (!field) return
    setJoining(true)
    setJoinError(undefined)
    try {
      // サーバーで断られたのに自分の PDS だけ参加中にならないように、サーバーが通ってから書く
      await joinField(agent, field.ref)
      await writeMember(agent, did, field.ref)
      navigate(fieldPath(field.ref), { replace: true })
    } catch (e) {
      // 410: 閉じた（削除された）フィールド
      setJoinError(e instanceof BackendError && e.status === 410 ? 'このフィールドは削除されました' : `参加できませんでした：${errorMessage(e)}`)
      setJoining(false)
    }
  }

  return (
    <>
      <PageHeader title="共同フィールド" />
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
