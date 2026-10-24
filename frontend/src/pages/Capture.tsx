// S3 撮影・ステッカー化。画像を選ぶ → /cutout でステッカーにする → 公開の確認をして PDS に保存する。
import { useState, type ChangeEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { cutout, type CutoutResponse } from '../api/backend.ts'
import { CAPTION_MAX, countGraphemes, createSticker } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import PageHeader from '../components/PageHeader.tsx'
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
  const [mode, setMode] = useState<'camera' | 'file'>('camera')
  const [ownWork, setOwnWork] = useState(false)
  const [caption, setCaption] = useState('')
  const [confirmed, setConfirmed] = useState(false)
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
    setConfirmed(false)
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
      setConfirmed(false)
      setStep({ ...step, kind: 'preview' })
    }
  }

  if (step.kind === 'cutting') {
    return (
      <>
        <PageHeader title="ステッカー作成" />
        <div className="capture-viewer">
          <p role="status">ステッカーにしています…</p>
        </div>
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
        <div className="capture-back">
          <button type="button" className="icon-button" onClick={reset} disabled={saving} aria-label="選び直す">
            <img src="/images/back.svg" alt="" width={13} height={18} />
          </button>
          <h1>プレビュー</h1>
        </div>
        <div className="capture-image">
          <img src={`data:image/png;base64,${step.result.image}`} alt="できたステッカー" />
        </div>
        <div className="capture-tags">
          <span className={step.source === 'photo' ? 'tag' : 'tag tag-illustration'}>{step.source === 'photo' ? '写真' : 'イラスト'}</span>
          <span className="tag tag-field">✓位置情報を削除済み</span>
        </div>
        <label className="capture-caption">
          どんな味？（任意）
          <input type="text" className="input" value={caption} onChange={(e) => setCaption(e.target.value)} disabled={saving} />
        </label>
        <p className={captionTooLong ? 'capture-count over' : 'capture-count'}>
          {captionLength}/{CAPTION_MAX}
        </p>

        <div className="notice capture-notice">
          <img src="/images/globe.svg" alt="" width={18} height={18} />
          <div>
            <p className="notice-title">このステッカーは公開されます</p>
            <p>Blueskyのアカウントを持つ人なら誰でも見られます</p>
          </div>
          <label className="capture-confirm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={saving} />
            公開されることを確認しました
          </label>
        </div>

        <button type="button" className="btn btn-primary btn-block capture-save" onClick={save} disabled={!confirmed || captionTooLong || saving}>
          {saving ? '保存しています…' : '保存する'}
        </button>
        {error && <p role="alert">{error}</p>}
      </>
    )
  }

  return (
    <>
      <PageHeader title="ステッカー作成" />
      <div className="segmented capture-modes">
        <button type="button" aria-pressed={mode === 'camera'} className={mode === 'camera' ? 'active' : undefined} onClick={() => setMode('camera')}>
          撮影
        </button>
        <button type="button" aria-pressed={mode === 'file'} className={mode === 'file' ? 'active' : undefined} onClick={() => setMode('file')}>
          ファイルから選択
        </button>
      </div>

      {mode === 'camera' ? (
        <>
          <div className="capture-viewer">
            <div className="capture-frame">下のボタンでカメラが開きます</div>
            <p>
              モノを枠の中に。背景は自動で消えます
              <br />
              紙に描いたイラストもそのまま撮れます
            </p>
          </div>
          <label className="capture-shutter">
            <input type="file" className="visually-hidden" accept="image/*" capture="environment" onChange={(e) => onFile(e, 'photo')} />
            <img src="/images/shutter.svg" alt="" width={63} height={63} />
            <span className="visually-hidden">撮影する</span>
          </label>
        </>
      ) : (
        <div className="capture-files">
          <section className="card">
            <h2 className="section-title">写真</h2>
            <label className="btn btn-primary btn-block">
              <input type="file" className="visually-hidden" accept="image/*" onChange={(e) => onFile(e, 'photo')} />
              写真を選ぶ
            </label>
          </section>
          <section className="card">
            <h2 className="section-title">イラスト（PNG）</h2>
            <label className="capture-confirm">
              <input type="checkbox" checked={ownWork} onChange={(e) => setOwnWork(e.target.checked)} />
              これは自分で描いたものです
            </label>
            <label className={ownWork ? 'btn btn-primary btn-block' : 'btn btn-primary btn-block disabled'}>
              <input type="file" className="visually-hidden" accept="image/png" disabled={!ownWork} onChange={(e) => onFile(e, 'illustration')} />
              イラストを選ぶ
            </label>
          </section>
        </div>
      )}

      {error && <p role="alert">{error}</p>}
    </>
  )
}
