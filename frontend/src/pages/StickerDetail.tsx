// S6 ステッカー詳細。持ち主の PDS からステッカーを読み、自分の PDS の exchange に受け取った記録があれば相手と日時と場面を出す。
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { listOwnRecords } from '../api/binder.ts'
import { deleteSticker, getStickerByRkey } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import Handle from '../components/Handle.tsx'
import StickerImage, { StickerBackdrop } from '../components/StickerImage.tsx'
import { NSID, type Exchange, type StrongRef, type Sticker } from '../lexicon-types.ts'

type State = { status: 'loading' } | { status: 'gone' } | { status: 'ok'; ref: StrongRef; sticker: Sticker }

/** 読んだ結果と、どの did/rkey を読んだか。URL が変わったら読み直す間は loading とみなす */
type Loaded = { key: string; state: State }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function StickerDetail() {
  const { did = '', rkey = '' } = useParams()
  const auth = useAuth()
  const navigate = useNavigate()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const myDid = auth.status === 'signedIn' ? auth.did : undefined

  const key = `${did}/${rkey}`
  const [loaded, setLoaded] = useState<Loaded>()
  const state: State = loaded?.key === key ? loaded.state : { status: 'loading' }
  const setState = (next: State) => setLoaded({ key, state: next })
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    getStickerByRkey(did, rkey)
      .then(({ ref, sticker }) => !cancelled && setLoaded({ key, state: { status: 'ok', ref, sticker } }))
      .catch(() => !cancelled && setLoaded({ key, state: { status: 'gone' } }))
    return () => {
      cancelled = true
    }
  }, [did, rkey, key])

  const stickerUri = state.status === 'ok' ? state.ref.uri : undefined

  useEffect(() => {
    if (!agent || !myDid || !stickerUri) return
    let cancelled = false
    listOwnRecords<Exchange>(agent, myDid, NSID.exchange)
      .then((records) => !cancelled && setExchanges(records.map((r) => r.value).filter((x) => x.received?.uri === stickerUri)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agent, myDid, stickerUri])

  async function onDelete() {
    if (!agent || !myDid || state.status !== 'ok') return
    if (!window.confirm('このステッカーを削除しますか？\nタイムラインと、交換した相手のシール帳からも消えます。')) return
    setDeleting(true)
    setDeleteError(undefined)
    try {
      await deleteSticker(agent, myDid, state.ref.uri)
      setState({ status: 'gone' })
    } catch (e) {
      setDeleteError(`削除できませんでした：${errorMessage(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <StickerBackdrop>
      <button type="button" onClick={() => navigate(-1)}>
        ← 戻る
      </button>

      {state.status === 'loading' && <p>読み込み中…</p>}
      {state.status === 'gone' && <p style={{ marginTop: 48, textAlign: 'center' }}>このステッカーは削除されました</p>}
      {state.status === 'ok' && (
        <>
          <div style={{ margin: '16px 0' }}>
            <StickerImage did={did} sticker={state.sticker} maxHeight={360} />
          </div>
          <p style={{ fontWeight: 'bold', margin: '0 0 4px' }}>
            <Handle did={did} />
          </p>
          <p style={{ margin: '0 0 4px', color: '#666', fontSize: 14 }}>
            {formatDateTime(state.sticker.createdAt)}・{state.sticker.source === 'photo' ? '写真' : 'イラスト'}
          </p>
          {state.sticker.caption && <p style={{ margin: '8px 0' }}>{state.sticker.caption}</p>}

          {exchanges.map((x) => (
            <p key={x.sessionId} style={{ margin: '8px 0', fontSize: 14 }}>
              <Handle did={x.partner} /> さんと {formatDate(x.createdAt)} に交換{x.occasion ? `（場面：${x.occasion}）` : ''}
            </p>
          ))}

          {myDid === did && (
            <div style={{ marginTop: 24 }}>
              <button type="button" onClick={onDelete} disabled={deleting} style={{ color: '#c00' }}>
                {deleting ? '削除しています…' : '削除'}
              </button>
              {deleteError && <p role="alert">{deleteError}</p>}
            </div>
          )}
        </>
      )}
    </StickerBackdrop>
  )
}
