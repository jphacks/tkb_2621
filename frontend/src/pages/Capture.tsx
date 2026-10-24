// S3 撮影・ステッカー化。画像を選ぶ → /cutout でステッカーにする → 公開の確認をして PDS に保存する。
import { useState, type ChangeEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { cutout, type CutoutResponse } from '../api/backend.ts'
import { CAPTION_MAX, countGraphemes, createSticker } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import type { Sticker } from '../lexicon-types.ts'

type Source = Sticker['source']

type Step =
  | { kind: 'choose' }
  | { kind: 'cutting' }
  | { kind: 'preview'; source: Source; result: CutoutResponse; png: Blob }
  | { kind: 'saving'; source: Source; result: CutoutResponse; png: Blob }

function base64ToPng(base64: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: 'image/png' })
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function Capture() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [ownWork, setOwnWork] = useState(false)
  const [caption, setCaption] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string>()

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />
  const { agent, did } = auth

  async function onFile(e: ChangeEvent<HTMLInputElement>, source: Source) {
    const file = e.target.files?.[0]
    // 同じファイルを選び直しても onChange が走るように空にしておく
    e.target.value = ''
    if (!file) return
    if (source === 'illustration' && file.type !== 'image/png') {
      setError('イラストは PNG を選んでください')
      return
    }
    setError(undefined)
    setStep({ kind: 'cutting' })
    try {
      const result = await cutout(agent, file, source)
      setCaption('')
      setStep({ kind: 'preview', source, result, png: base64ToPng(result.image) })
    } catch (err) {
      setError(`ステッカーにできませんでした：${errorMessage(err)}`)
      setStep({ kind: 'choose' })
    }
  }

  function reset() {
    setStep({ kind: 'choose' })
    setConfirming(false)
    setCaption('')
    setError(undefined)
  }

  async function save() {
    if (step.kind !== 'preview') return
    setError(undefined)
    setStep({ ...step, kind: 'saving' })
    try {
      await createSticker(agent, did, {
        png: step.png,
        width: step.result.width,
        height: step.result.height,
        source: step.source,
        caption,
      })
      navigate('/binder')
    } catch (err) {
      setError(`保存できませんでした：${errorMessage(err)}`)
      setConfirming(false)
      setStep({ ...step, kind: 'preview' })
    }
  }

  if (step.kind === 'cutting') {
    return (
      <>
        <h1>撮影・ステッカー化</h1>
        <p role="status">ステッカーにしています…</p>
        <BackendWaking />
      </>
    )
  }

  if (step.kind === 'preview' || step.kind === 'saving') {
    const captionLength = countGraphemes(caption)
    const captionTooLong = captionLength > CAPTION_MAX
    const saving = step.kind === 'saving'
    return (
      <>
        <h1>撮影・ステッカー化</h1>
        <img
          src={`data:image/png;base64,${step.result.image}`}
          alt="できたステッカー"
          style={{ maxWidth: '100%', maxHeight: '50vh', background: 'repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 16px 16px' }}
        />
        <p>
          <label>
            一言（任意、{CAPTION_MAX}文字まで）
            <br />
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} disabled={saving} />
          </label>
          <br />
          <small style={captionTooLong ? { color: '#c62828' } : undefined}>
            {captionLength} / {CAPTION_MAX}
          </small>
        </p>

        {confirming ? (
          <div role="dialog" aria-label="公開の確認">
            <p>このステッカーは公開されます。Blueskyのアカウントを持つ人なら誰でも見られます</p>
            <button type="button" onClick={save} disabled={saving}>
              {saving ? '保存しています…' : '公開して保存'}
            </button>{' '}
            <button type="button" onClick={() => setConfirming(false)} disabled={saving}>
              やめる
            </button>
          </div>
        ) : (
          <p>
            <button type="button" onClick={() => setConfirming(true)} disabled={captionTooLong}>
              保存
            </button>{' '}
            <button type="button" onClick={reset}>
              選び直す
            </button>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </>
    )
  }

  return (
    <>
      <h1>撮影・ステッカー化</h1>

      <h2>写真</h2>
      <label>
        写真を撮る／選ぶ
        <br />
        <input type="file" accept="image/*" capture="environment" onChange={(e) => onFile(e, 'photo')} />
      </label>

      <h2>イラスト</h2>
      <p>
        <label>
          <input type="checkbox" checked={ownWork} onChange={(e) => setOwnWork(e.target.checked)} />
          これは自分で描いたものです
        </label>
      </p>
      <label>
        イラストを選ぶ（PNG）
        <br />
        <input type="file" accept="image/png" disabled={!ownWork} onChange={(e) => onFile(e, 'illustration')} />
      </label>

      {error && <p role="alert">{error}</p>}
    </>
  )
}
