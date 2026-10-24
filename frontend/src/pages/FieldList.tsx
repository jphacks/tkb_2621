// S7 共同フィールド一覧。自分の PDS の field.member から参加中のものを並べ、新しく作れる。
import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { joinField } from '../api/backend.ts'
import { FIELD_TITLE_MAX, createField, fieldPath, listJoinedFields, type FieldView } from '../api/field.ts'
import { countGraphemes } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function FieldList() {
  const auth = useAuth()
  const navigate = useNavigate()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const did = auth.status === 'signedIn' ? auth.did : undefined

  const [fields, setFields] = useState<FieldView[]>()
  const [listError, setListError] = useState<string>()
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()

  useEffect(() => {
    if (!agent || !did) return
    let cancelled = false
    listJoinedFields(agent, did)
      .then((list) => !cancelled && setFields(list))
      .catch((e: unknown) => !cancelled && setListError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, did])

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  const titleLength = countGraphemes(title.trim())

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    if (!agent || !did || titleLength === 0 || titleLength > FIELD_TITLE_MAX) return
    setCreating(true)
    setCreateError(undefined)
    try {
      const ref = await createField(agent, did, title)
      await joinField(agent, ref)
      navigate(fieldPath(ref))
    } catch (e) {
      setCreateError(`作れませんでした：${errorMessage(e)}`)
      setCreating(false)
    }
  }

  return (
    <>
      <h1>共同フィールド</h1>

      <form onSubmit={onCreate} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <label>
          タイトル（{titleLength}/{FIELD_TITLE_MAX}）
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例：JPHACKS 2026 東京B"
            style={{ display: 'block', width: '100%' }}
          />
        </label>
        <button type="submit" disabled={creating || titleLength === 0 || titleLength > FIELD_TITLE_MAX}>
          {creating ? '作っています…' : '新しく作る'}
        </button>
        {creating && <BackendWaking />}
        {createError && <p role="alert">{createError}</p>}
      </form>

      <h2 style={{ fontSize: 16 }}>参加中</h2>
      {listError && <p role="alert">読めませんでした：{listError}</p>}
      {!fields && !listError && <p>読み込み中…</p>}
      {fields?.length === 0 && <p>まだ参加していません。作るか、招待 QR を iPhone のカメラで読んでください</p>}
      <ul>
        {fields?.map((field) => (
          <li key={field.ref.uri}>
            <Link to={fieldPath(field.ref)}>{field.title}</Link>
          </li>
        ))}
      </ul>
    </>
  )
}
