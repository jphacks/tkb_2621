// PDS の読み書きと getServiceAuth を確かめるための仮の画面。骨組みが通ったらルートごと消す。
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import { SERVICE_AUTH_LXM } from '../auth/scope.ts'
import { NSID, type BlobRef, type Sticker } from '../lexicon-types.ts'

const SIZE = 64

/** 64×64 の透過PNG（丸を1つ描く）をその場で作る */
function makeDummyPng(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#4caf50'
  ctx.beginPath()
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 4, 0, Math.PI * 2)
  ctx.fill()
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG を作れなかった'))), 'image/png'),
  )
}

function decodeJwtPayload(token: string): unknown {
  const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(payload))
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

type Result = { ok: boolean; text: string }

function ResultView({ result }: { result?: Result }) {
  if (!result) return null
  return (
    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: result.ok ? '#2e7d32' : '#c62828' }}>
      {result.ok ? '成功\n' : '失敗\n'}
      {result.text}
    </pre>
  )
}

export default function Debug() {
  const auth = useAuth()
  const [create, setCreate] = useState<Result>()
  const [list, setList] = useState<Result>()
  const [serviceAuth, setServiceAuth] = useState<Result>()

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />
  const { agent, did } = auth

  async function createSticker() {
    setCreate(undefined)
    try {
      const png = await makeDummyPng()
      const { data: uploaded } = await agent.uploadBlob(png, { encoding: 'image/png' })
      const record: Sticker = {
        $type: NSID.sticker,
        image: uploaded.blob.toJSON() as BlobRef,
        width: SIZE,
        height: SIZE,
        source: 'illustration',
        caption: 'debug',
        createdAt: new Date().toISOString(),
      }
      const { data } = await agent.com.atproto.repo.createRecord({
        repo: did,
        collection: NSID.sticker,
        record: { ...record },
      })
      setCreate({ ok: true, text: `uri: ${data.uri}\ncid: ${data.cid}` })
    } catch (e) {
      setCreate({ ok: false, text: errorMessage(e) })
    }
  }

  async function listStickers() {
    setList(undefined)
    try {
      const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: NSID.sticker, limit: 50 })
      const lines = data.records.map((r) => {
        const value = r.value as unknown as Sticker
        return `${r.uri}\n  ${value.source} ${value.width}x${value.height} ${value.createdAt}`
      })
      setList({ ok: true, text: `${data.records.length} 件\n${lines.join('\n')}` })
    } catch (e) {
      setList({ ok: false, text: errorMessage(e) })
    }
  }

  async function getServiceAuth() {
    setServiceAuth(undefined)
    const aud = import.meta.env.VITE_BACKEND_DID as string | undefined
    if (!aud) {
      setServiceAuth({ ok: false, text: 'VITE_BACKEND_DID が設定されていない' })
      return
    }
    try {
      const { data } = await agent.com.atproto.server.getServiceAuth({ aud, lxm: SERVICE_AUTH_LXM })
      const payload = JSON.stringify(decodeJwtPayload(data.token), null, 2)
      setServiceAuth({ ok: true, text: `JWT を取得（${data.token.length} 文字）\n${payload}` })
    } catch (e) {
      setServiceAuth({ ok: false, text: `aud: ${aud}\n${errorMessage(e)}` })
    }
  }

  return (
    <>
      <h1>debug</h1>
      <p>DID：{did}</p>

      <h2>1. ステッカーを1件書く</h2>
      <button type="button" onClick={createSticker}>
        uploadBlob → createRecord
      </button>
      <ResultView result={create} />

      <h2>2. 自分のステッカーを読み戻す</h2>
      <button type="button" onClick={listStickers}>
        listRecords
      </button>
      <ResultView result={list} />

      <h2>3. getServiceAuth</h2>
      <button type="button" onClick={getServiceAuth}>
        getServiceAuth
      </button>
      <ResultView result={serviceAuth} />
    </>
  )
}
