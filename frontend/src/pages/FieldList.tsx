// S7 共同フィールド一覧。自分の PDS の field.member から参加中のものを並べ、新しく作れる。
// 削除されたものは「削除済み」と出す。開いたとき、自分が作って閉じた field の後始末もする。
// 前に開いたときの一覧があればまずそれを出し、裏で読み直す。
import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { joinField } from '../api/backend.ts'
import {
  FIELD_TITLE_MAX,
  INVITE_CODE_LENGTH,
  cleanupClosedOwnFields,
  createField,
  discardCreatedField,
  fieldPath,
  invitePathForCode,
  listJoinedFields,
  normalizeInviteCode,
  type JoinedField,
} from '../api/field.ts'
import { readCache, writeCache } from '../api/screenCache.ts'
import { countGraphemes } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import Loading from '../components/Loading.tsx'
import QrScanner from '../components/QrScanner.tsx'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 読んだ QR が Pikkles の招待 URL（inviteUrl）なら、開く先のパスを返す。ほかのサイトの URL は開かない */
function invitePath(text: string): string | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.origin !== window.location.origin || url.pathname !== '/fields/join') return undefined
  const code = normalizeInviteCode(url.searchParams.get('code') ?? '')
  return code ? invitePathForCode(code) : undefined
}

export default function FieldList() {
  const auth = useAuth()
  const navigate = useNavigate()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const did = auth.status === 'signedIn' ? auth.did : undefined
  const cacheKey = did && `fields:${did}`

  const [fields, setFields] = useState(() => readCache<JoinedField[]>(cacheKey))
  const [listError, setListError] = useState<string>()
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()
  // 「新しく作る」の入力欄と「招待QRを読む」のカメラと「コードで参加」の入力欄は、ボタンを押したときだけ開く
  const [panel, setPanel] = useState<'create' | 'scan' | 'code'>()
  const [scanError, setScanError] = useState<string>()
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!agent || !did) return
    let cancelled = false
    // 作った人が先に抜けていて閉じた field を消す。失敗しても一覧は出す
    void cleanupClosedOwnFields(agent, did).catch(() => undefined)
    listJoinedFields(agent, did)
      .then((list) => {
        writeCache(`fields:${did}`, list)
        if (!cancelled) setFields(list)
      })
      .catch((e: unknown) => !cancelled && setListError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, did])

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  const titleLength = countGraphemes(title.trim())

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    if (!agent || !did || titleLength === 0 || titleLength > FIELD_TITLE_MAX) return
    setCreating(true)
    setCreateError(undefined)
    try {
      const ref = await createField(agent, did, title)
      try {
        await joinField(agent, ref)
      } catch (err) {
        // 一覧に「作れなかった」フィールドが残り、作り直すと2つになるので、書いたものを消しておく
        await discardCreatedField(agent, did, ref).catch(() => undefined)
        throw err
      }
      navigate(fieldPath(ref))
    } catch (e) {
      setCreateError(`作れませんでした：${errorMessage(e)}`)
      setCreating(false)
    }
  }

  const normalizedCode = normalizeInviteCode(code)

  function onCode(e: FormEvent) {
    e.preventDefault()
    if (normalizedCode.length !== INVITE_CODE_LENGTH) return
    navigate(invitePathForCode(normalizedCode))
  }

  function onScan(text: string): boolean {
    const path = invitePath(text)
    if (!path) {
      setScanError('共同フィールドの招待 QR ではありません')
      return false
    }
    navigate(path)
    return true
  }

  return (
    <>
      <div className="field-actions">
        <button type="button" className="btn btn-primary" onClick={() => setPanel(panel === 'create' ? undefined : 'create')} aria-expanded={panel === 'create'}>
          ＋ 新しく作る
        </button>
        <button type="button" className="btn" onClick={() => setPanel(panel === 'scan' ? undefined : 'scan')} aria-expanded={panel === 'scan'}>
          <img src="/images/scan.svg" alt="" width={12} height={12} />
          招待QRを読む
        </button>
        <button type="button" className="btn" onClick={() => setPanel(panel === 'code' ? undefined : 'code')} aria-expanded={panel === 'code'}>
          コードで参加
        </button>
      </div>

      {panel === 'create' && (
        <form onSubmit={onCreate} className="card field-create">
          <label className="exchange-occasion">
            タイトル
            <input type="text" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：JPHACKS 2026 東京B" />
          </label>
          <p className={titleLength > FIELD_TITLE_MAX ? 'capture-count over' : 'capture-count'}>
            {titleLength}/{FIELD_TITLE_MAX}
          </p>
          <button type="submit" className="btn btn-primary btn-block" disabled={creating || titleLength === 0 || titleLength > FIELD_TITLE_MAX}>
            {creating ? '作っています…' : '作る'}
          </button>
          {creating && <BackendWaking />}
          {createError && <p role="alert">{createError}</p>}
        </form>
      )}

      {panel === 'scan' && (
        <div className="field-create">
          <QrScanner hint="招待 QR を枠の中に" onResult={onScan} />
          {scanError && <p role="alert">{scanError}</p>}
        </div>
      )}

      {panel === 'code' && (
        <form onSubmit={onCode} className="card field-create">
          <label className="exchange-occasion">
            招待コード（6文字）
            <input
              type="text"
              className="input field-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="例：K7P 3QX"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={INVITE_CODE_LENGTH + 2}
            />
          </label>
          <p className="text-muted">その場のメンバーに、共同フィールドの招待を出してもらってください。コードは10分で切れます</p>
          <button type="submit" className="btn btn-primary btn-block" disabled={normalizedCode.length !== INVITE_CODE_LENGTH}>
            次へ
          </button>
        </form>
      )}

      <h2 className="field-list-title">参加中</h2>
      {listError && <p role="alert">読めませんでした：{listError}</p>}
      {!fields && !listError && <Loading />}
      {fields?.length === 0 && <p className="text-muted">まだ参加していません。作るか、招待 QR かコードで参加してください</p>}
      <ul className="field-list">
        {fields?.map((joined) => (
          <li key={joined.uri}>
            <Link to={fieldPath({ uri: joined.uri })} className="card field-card">
              <span className="field-card-thumb" aria-hidden="true" />
              <span className="field-card-title">{joined.field?.title ?? '削除されたフィールド'}</span>
              {joined.deleted && <span className="tag field-card-deleted">削除済み</span>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
