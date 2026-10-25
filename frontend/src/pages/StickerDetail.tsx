// S6 ピクルス詳細（docs/sticker-detail.md）。持ち主の PDS からステッカーを読み、作った人の Bluesky のプロフィールと、
// 成立した交換で受け取っていればその日時と場面と、相手の記録にある一言を出す。
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { listEstablishedExchanges } from '../api/binder.ts'
import { getPartnerMessage } from '../api/exchange.ts'
import { getProfile, type Profile } from '../api/profile.ts'
import { deleteSticker, getStickerByRkey } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import Avatar from '../components/Avatar.tsx'
import Handle from '../components/Handle.tsx'
import Loading from '../components/Loading.tsx'
import StickerImage from '../components/StickerImage.tsx'
import type { Did, Exchange, StrongRef, Sticker } from '../lexicon-types.ts'

type State = { status: 'loading' } | { status: 'gone' } | { status: 'ok'; ref: StrongRef; sticker: Sticker }

/** 読んだ結果と、どの did/rkey を読んだか。URL が変わったら読み直す間は loading とみなす */
type Loaded = { key: string; state: State }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 2026/10/25 14:05 */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const AVATAR_SIZE = 38

type ProfileState = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; profile: Profile }

/** ③ 作った人のプロフィールカード。読めないときはハンドルか DID だけを出す。押すと Bluesky のプロフィールを開く */
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
  const bio = profile?.description?.trim()

  return (
    <a
      className="detail-card detail-card-link"
      href={`https://bsky.app/profile/${did}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-busy={state.status === 'loading'}
    >
      <h2 className="detail-card-label">作成者</h2>
      <div className="detail-profile">
        {state.status === 'loading' ? (
          <span className="avatar detail-skeleton" style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }} />
        ) : profile?.avatar ? (
          <img className="detail-profile-avatar" src={profile.avatar} alt="" width={AVATAR_SIZE} height={AVATAR_SIZE} />
        ) : (
          <Avatar did={did} size={AVATAR_SIZE} />
        )}
        <div className="detail-profile-names">
          {state.status === 'loading' && <div className="detail-skeleton detail-skeleton-line" />}
          {state.status === 'failed' && (
            <p className="detail-profile-name">
              <Handle did={did} />
            </p>
          )}
          {profile && (
            <>
              <p className="detail-profile-name">{profile.displayName || `@${profile.handle}`}</p>
              <p className="detail-profile-handle">@{profile.handle}</p>
            </>
          )}
        </div>
      </div>
      {bio && <p className="detail-profile-bio">{bio}</p>}
    </a>
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
    <section className="detail-card detail-exchange">
      <h2 className="detail-exchange-title">交換の記録</h2>
      <dl className="detail-exchange-list">
        <div className="detail-exchange-row">
          <dt>日時</dt>
          <dd>{formatDateTime(exchange.createdAt)}</dd>
        </div>
        {exchange.occasion && (
          <div className="detail-exchange-row">
            <dt>場所</dt>
            <dd>{exchange.occasion}</dd>
          </div>
        )}
        {message && (
          <div className="detail-exchange-row detail-exchange-row-stack">
            <dt>コメント</dt>
            <dd>{message}</dd>
          </div>
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
    // 成立しなかった交換の記録も自分の PDS に残るので、相手の PDS に対になる記録があるものだけを出す
    listEstablishedExchanges(agent, myDid, (x) => x.received?.uri === stickerUri)
      .then((list) => !cancelled && setExchanges(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agent, myDid, stickerUri])

  async function onDelete() {
    if (!agent || !myDid || state.status !== 'ok') return
    if (!window.confirm('このピクルスを削除しますか？\nタイムラインと、交換した相手のビンからも消えます。')) return
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
    <>
      <button type="button" className="icon-button detail-back" onClick={() => navigate(-1)} aria-label="戻る">
        <img src="/images/back.svg" alt="" width={13} height={18} />
      </button>

      {state.status === 'loading' && <Loading />}
      {state.status === 'gone' && <p className="detail-gone">このピクルスは削除されました</p>}
      {state.status === 'ok' && (
        <>
          <div className="detail-image">
            <StickerImage did={did} sticker={state.sticker} maxHeight={220} />
          </div>
          <p className="detail-meta">
            <span className={state.sticker.source === 'photo' ? 'tag' : 'tag tag-illustration'}>
              {state.sticker.source === 'photo' ? '写真' : 'イラスト'}
            </span>
            {formatDateTime(state.sticker.createdAt)}につくった
          </p>
          {state.sticker.caption && <h1 className="detail-name">{state.sticker.caption}</h1>}

          <div className="detail-cards">
            <ProfileCard did={did} />
            {exchanges.map((x) => (
              <ExchangeCard key={x.sessionId} exchange={x} />
            ))}
          </div>

          {myDid === did && (
            <div className="detail-delete">
              <button type="button" className="btn btn-block" onClick={onDelete} disabled={deleting}>
                {deleting ? '削除しています…' : '削除'}
              </button>
              {deleteError && <p role="alert">{deleteError}</p>}
            </div>
          )}
        </>
      )}
    </>
  )
}
