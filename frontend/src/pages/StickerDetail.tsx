// S6 ピクルス詳細（docs/sticker-detail.md）。持ち主の PDS からステッカーを読み、作った人の Bluesky のプロフィールと、
// 自分の PDS の exchange に受け取った記録があればその日時と場面と、相手の記録にある一言を出す。
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { listOwnRecords } from '../api/binder.ts'
import { getPartnerMessage } from '../api/exchange.ts'
import { firstLine, getProfile, type Profile } from '../api/profile.ts'
import { deleteSticker, getStickerByRkey } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import Avatar from '../components/Avatar.tsx'
import Handle from '../components/Handle.tsx'
import StickerImage, { StickerBackdrop } from '../components/StickerImage.tsx'
import { NSID, type Did, type Exchange, type StrongRef, type Sticker } from '../lexicon-types.ts'

type State = { status: 'loading' } | { status: 'gone' } | { status: 'ok'; ref: StrongRef; sticker: Sticker }

/** 読んだ結果と、どの did/rkey を読んだか。URL が変わったら読み直す間は loading とみなす */
type Loaded = { key: string; state: State }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const muted = { color: 'var(--color-text-muted)', fontSize: 'var(--font-size-md)' }
const oneLine = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const

type ProfileState = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; profile: Profile }

/** ③ 作った人のプロフィールカード。読めないときはハンドルか DID だけを出す */
function ProfileCard({ did }: { did: Did }) {
  const [loaded, setLoaded] = useState<{ did: Did; state: ProfileState }>()
  const state: ProfileState = loaded?.did === did ? loaded.state : { status: 'loading' }

  useEffect(() => {
    let cancelled = false
    getProfile(did)
      .then((profile) => !cancelled && setLoaded({ did, state: { status: 'ok', profile } }))
      .catch(() => !cancelled && setLoaded({ did, state: { status: 'failed' } }))
    return () => {
      cancelled = true
    }
  }, [did])

  const profile = state.status === 'ok' ? state.profile : undefined
  const bio = firstLine(profile?.description)

  return (
    <section className="card" aria-busy={state.status === 'loading'} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
      {state.status === 'loading' ? (
        <span className="avatar" style={{ width: 48, height: 48, background: 'var(--color-surface-muted)' }} />
      ) : profile?.avatar ? (
        <img src={profile.avatar} alt="" width={48} height={48} style={{ flex: 'none', borderRadius: '50%', objectFit: 'cover' }} />
      ) : (
        <Avatar did={did} size={48} />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {state.status === 'loading' && (
          <div style={{ height: 14, width: '60%', borderRadius: 'var(--radius-xs)', background: 'var(--color-surface-muted)' }} />
        )}
        {state.status === 'failed' && (
          <p style={{ margin: 0, fontWeight: 'var(--font-weight-bold)', ...oneLine }}>
            <Handle did={did} />
          </p>
        )}
        {profile && (
          <>
            <p style={{ margin: 0, fontWeight: 'var(--font-weight-bold)', ...oneLine }}>{profile.displayName || `@${profile.handle}`}</p>
            <p style={{ margin: 0, ...muted, ...oneLine }}>@{profile.handle}</p>
            {bio && <p style={{ margin: 'var(--space-1) 0 0', ...oneLine }}>{bio}</p>}
          </>
        )}
      </div>
    </section>
  )
}

/** ④ 交換の記録カード。もらったピクルスのときだけ出す。一言は相手の PDS から後で読む */
function ExchangeCard({ exchange }: { exchange: Exchange }) {
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    let cancelled = false
    getPartnerMessage(exchange.partner, exchange.sessionId)
      .then((m) => !cancelled && setMessage(m))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [exchange.partner, exchange.sessionId])

  return (
    <section className="card">
      <p style={{ margin: '0 0 var(--space-2)', fontWeight: 'var(--font-weight-bold)' }}>交換の記録</p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-1) var(--space-3)', margin: 0 }}>
        <dt style={muted}>日時</dt>
        <dd style={{ margin: 0 }}>{formatDateTime(exchange.createdAt)}</dd>
        {exchange.occasion && (
          <>
            <dt style={muted}>場所</dt>
            <dd style={{ margin: 0 }}>{exchange.occasion}</dd>
          </>
        )}
        {message && (
          <>
            <dt style={muted}>相手からの一言</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{message}</dd>
          </>
        )}
      </dl>
    </section>
  )
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
      .then(
        (records) =>
          !cancelled &&
          setExchanges(
            records
              .map((r) => r.value)
              .filter((x) => x.received?.uri === stickerUri)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          ),
      )
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agent, myDid, stickerUri])

  async function onDelete() {
    if (!agent || !myDid || state.status !== 'ok') return
    if (!window.confirm('このピクルスを削除しますか？\nタイムラインと、交換した相手のシール帳からも消えます。')) return
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
      {state.status === 'gone' && <p style={{ marginTop: 48, textAlign: 'center' }}>このピクルスは削除されました</p>}
      {state.status === 'ok' && (
        <>
          <div style={{ margin: '16px 0' }}>
            <StickerImage did={did} sticker={state.sticker} maxHeight={360} />
          </div>
          {state.sticker.caption && (
            <p style={{ margin: '0 0 var(--space-1)', fontWeight: 'var(--font-weight-bold)', textAlign: 'center' }}>{state.sticker.caption}</p>
          )}
          <p style={{ margin: '0 0 var(--space-4)', textAlign: 'center', ...muted }}>
            {formatDateTime(state.sticker.createdAt)}・{state.sticker.source === 'photo' ? '写真' : 'イラスト'}
          </p>

          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <ProfileCard did={did} />
            {exchanges.map((x) => (
              <ExchangeCard key={x.sessionId} exchange={x} />
            ))}
          </div>

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
