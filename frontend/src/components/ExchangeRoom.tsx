// 対面交換の「選ぶ → 確定 → 記録」（spec 6章の3〜8）。始めた人・参加した人の両方がこの画面を使う。
import { AtUri, type Agent } from '@atproto/api'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Avatar from './Avatar.tsx'
import {
  commitExchange,
  openExchangeSocket,
  type CommitResponse,
  type ExchangeSocket,
  type ExchangeView,
  type ServerMessage,
} from '../api/backend.ts'
import { getPartnerMessage, MESSAGE_MAX } from '../api/exchange.ts'
import { follow, isFollowing } from '../api/follow.ts'
import { countGraphemes, getSticker, resolveDid, stickerImageUrl } from '../api/sticker.ts'
import { listWantedBy } from '../api/want.ts'
import { NSID, type Did, type Exchange, type StrongRef, type Sticker } from '../lexicon-types.ts'

interface MySticker {
  ref: StrongRef
  sticker: Sticker
  imageUrl: string
}

type Phase =
  | { kind: 'selecting' }
  | { kind: 'recording' }
  | { kind: 'waiting_partner'; uri: string }
  | { kind: 'completed'; exchange?: ExchangeView }
  | { kind: 'failed'; reason: string; uri?: string }
  | { kind: 'cancelled'; reason: string }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const IMAGE_SIZE = 96

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 交換成立後に「Blueskyでもフォローする？」と聞く（spec 3章 #13）。押したときだけフォローを書く。フォロー済みなら出さない */
function FollowPrompt({ agent, did, partner, handle }: { agent: Agent; did: Did; partner: Did; handle?: string }) {
  const [state, setState] = useState<'checking' | 'ask' | 'following' | 'sending' | 'done' | 'error'>('checking')

  useEffect(() => {
    let cancelled = false
    isFollowing(did, partner)
      .then((following) => !cancelled && setState(following ? 'following' : 'ask'))
      // 確かめられなかったときは聞く（選んだときだけ書くので、勝手には増えない）
      .catch(() => !cancelled && setState('ask'))
    return () => {
      cancelled = true
    }
  }, [did, partner])

  async function onFollow() {
    setState('sending')
    try {
      await follow(agent, did, partner)
      setState('done')
    } catch {
      setState('error')
    }
  }

  if (state === 'checking' || state === 'following') return null
  if (state === 'done') return <p className="card exchange-follow">Blueskyでフォローしました</p>
  const name = handle ? `@${handle}` : partner
  return (
    <div className="card exchange-follow">
      <span>Blueskyでも{name}さんをフォローする</span>
      <button type="button" className="btn btn-primary" onClick={() => void onFollow()} disabled={state === 'sending'}>
        フォローする
      </button>
      {state === 'error' && (
        <small role="alert" className="exchange-follow-error">
          フォローできませんでした。ログインし直すとできることがあります
        </small>
      )}
    </div>
  )
}

/** 成立表示で、相手が添えた一言を出す。相手の記録が読めるまでは何も出さない */
function PartnerMessage({ partner, sessionId }: { partner: Did; sessionId: string }) {
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    let cancelled = false
    getPartnerMessage(partner, sessionId)
      .then((m) => !cancelled && setMessage(m))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [partner, sessionId])

  return message ? <p className="card exchange-message">相手からの一言：{message}</p> : null
}

export default function ExchangeRoom(props: {
  agent: Agent
  did: Did
  sessionId: string
  occasion: string | null
  /** 相手が参加済みか。まだなら waiting を出す（相手の選択が届いたら参加済みとみなす） */
  partnerJoined: boolean
  waiting?: ReactNode
  onJoined?: () => void
}) {
  const { agent, did, sessionId, onJoined } = props
  const [occasion, setOccasion] = useState(props.occasion)
  const [phase, setPhase] = useState<Phase>({ kind: 'selecting' })
  const [myStickers, setMyStickers] = useState<MySticker[]>()
  const [loadError, setLoadError] = useState<string>()
  const [selected, setSelected] = useState<StrongRef>()
  const [confirmed, setConfirmed] = useState(false)
  /** 相手に渡す一言（任意） */
  const [message, setMessage] = useState('')
  const [partnerRef, setPartnerRef] = useState<StrongRef>()
  const [partnerImage, setPartnerImage] = useState<string>()
  const [partnerHandle, setPartnerHandle] = useState<string>()
  const [rejected, setRejected] = useState(false)
  /** 相手が「ほしい」を付けたステッカーの URI */
  const [partnerWants, setPartnerWants] = useState<Set<string>>()

  const socketRef = useRef<ExchangeSocket>(undefined)
  // WebSocket のハンドラから最新の値を読むための写し
  const latest = useRef({ selected, partnerRef, occasion, message })
  useLayoutEffect(() => {
    latest.current = { selected, partnerRef, occasion, message }
  })
  // both_confirmed は再接続で送り直されるので、記録は1回だけ書く
  const recordStarted = useRef(false)

  const partnerDid = partnerRef ? new AtUri(partnerRef.uri).host : undefined
  const joined = props.partnerJoined || partnerRef !== undefined

  // 自分のステッカーを並べる
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: NSID.sticker, limit: 100 })
      const items = await Promise.all(
        data.records.map(async (r) => {
          const sticker = r.value as unknown as Sticker
          return { ref: { uri: r.uri, cid: r.cid }, sticker, imageUrl: await stickerImageUrl(did, sticker) }
        }),
      )
      if (!cancelled) setMyStickers(items)
    })().catch((e: unknown) => {
      if (!cancelled) setLoadError(errorMessage(e))
    })
    return () => {
      cancelled = true
    }
  }, [agent, did])

  // 相手の選んだステッカーの画像とハンドル
  useEffect(() => {
    if (!partnerRef) return
    let cancelled = false
    const owner = new AtUri(partnerRef.uri).host
    getSticker(partnerRef)
      .then((sticker) => stickerImageUrl(owner, sticker))
      .then((url) => !cancelled && setPartnerImage(url))
      .catch(() => !cancelled && setPartnerImage(undefined))
    resolveDid(owner)
      .then((info) => !cancelled && setPartnerHandle(info.handle))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [partnerRef])

  // 相手の「ほしい」。相手の DID は相手が選んだときに分かるので、それから読む
  useEffect(() => {
    if (!partnerDid) return
    let cancelled = false
    listWantedBy(partnerDid)
      .then((wants) => !cancelled && setPartnerWants(wants))
      // 読めなくても交換はできるので、並びを変えないだけにする
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [partnerDid])

  useEffect(() => {
    if (joined) onJoined?.()
  }, [joined, onJoined])

  function applyCommit(res: CommitResponse, uri: string) {
    if (res.result === 'completed') setPhase((p) => (p.kind === 'completed' ? p : { kind: 'completed' }))
    else if (res.result === 'waiting_partner') setPhase((p) => (p.kind === 'completed' ? p : { kind: 'waiting_partner', uri }))
    else setPhase({ kind: 'failed', reason: res.reason ?? '交換が成立しませんでした', uri })
  }

  async function sendCommit(uri: string) {
    try {
      applyCommit(await commitExchange(agent, sessionId, uri), uri)
    } catch (e) {
      setPhase({ kind: 'failed', reason: errorMessage(e), uri })
    }
  }

  async function record(messageOccasion: string | null) {
    const { selected: gave, partnerRef: received } = latest.current
    const note = latest.current.message.trim()
    if (!gave || !received) {
      setPhase({ kind: 'failed', reason: '選んだピクルスが分からなくなりました' })
      return
    }
    setPhase({ kind: 'recording' })
    try {
      const value: Exchange = {
        $type: NSID.exchange,
        sessionId,
        // サーバーのセッションの値をそのまま入れる。無ければ書かない
        ...(messageOccasion ? { occasion: messageOccasion } : {}),
        // 一言は書いたときだけ入れる
        ...(note ? { message: note } : {}),
        partner: new AtUri(received.uri).host,
        gave,
        received,
        createdAt: new Date().toISOString(),
      }
      const { data } = await agent.com.atproto.repo.createRecord({ repo: did, collection: NSID.exchange, record: { ...value } })
      await sendCommit(data.uri)
    } catch (e) {
      // 書けなかったときはもう一度書けるようにする
      recordStarted.current = false
      setPhase({ kind: 'failed', reason: `記録を書けませんでした：${errorMessage(e)}` })
    }
  }

  function onMessage(message: ServerMessage) {
    switch (message.type) {
      case 'partner_selected':
        setPartnerRef(message.sticker)
        break
      case 'both_confirmed':
        setOccasion(message.occasion)
        if (!recordStarted.current) {
          recordStarted.current = true
          void record(message.occasion)
        }
        break
      case 'completed':
        setPhase({ kind: 'completed', exchange: message.exchange })
        socketRef.current?.close()
        break
      case 'cancelled':
        setPhase({ kind: 'cancelled', reason: message.reason })
        socketRef.current?.close()
        break
    }
  }
  const handlerRef = useRef(onMessage)
  useLayoutEffect(() => {
    handlerRef.current = onMessage
  })

  useEffect(() => {
    const socket = openExchangeSocket(agent, sessionId, {
      onMessage: (message) => handlerRef.current(message),
      onRejected: () => setRejected(true),
    })
    socketRef.current = socket
    return () => socket.close()
  }, [agent, sessionId])

  function select(ref: StrongRef) {
    if (confirmed) return
    setSelected(ref)
    socketRef.current?.send({ type: 'select', sticker: ref })
  }

  const messageLength = countGraphemes(message)
  const messageTooLong = messageLength > MESSAGE_MAX

  function confirm() {
    if (!selected || messageTooLong) return
    setConfirmed(true)
    socketRef.current?.send({ type: 'confirm' })
  }

  // 相手が「ほしい」を付けたものを先頭に。それ以外の並びは変えない
  const sortedStickers = partnerWants
    ? myStickers && [...myStickers].sort((a, b) => Number(partnerWants.has(b.ref.uri)) - Number(partnerWants.has(a.ref.uri)))
    : myStickers

  const headerWith = (title: string) => (
    <>
      <div className="back-header">
        <Link to="/binder" className="icon-button" aria-label="ビンにもどる">
          <img src="/images/back.svg" alt="" width={13} height={18} />
        </Link>
        <h1>{title}</h1>
      </div>
      {occasion && <p className="tag tag-place">{occasion}</p>}
    </>
  )
  const header = headerWith('対面で交換')

  if (phase.kind === 'cancelled') {
    return (
      <>
        {header}
        <div role="alert" className="notice exchange-notice">
          <p className="notice-title">キャンセルされました</p>
          <p>{phase.reason}</p>
        </div>
        <Link to="/exchange" className="btn btn-primary btn-block exchange-bottom">
          もう一度はじめる
        </Link>
      </>
    )
  }

  if (phase.kind === 'completed') {
    const partner = phase.exchange?.partner ?? partnerDid
    const shownOccasion = phase.exchange ? phase.exchange.occasion : occasion
    return (
      <div className="exchange-done">
        <h1>交換成立!</h1>
        {partnerImage && <img src={partnerImage} alt="受け取ったピクルス" width={IMAGE_SIZE * 2} className="exchange-done-image" />}
        <p>{partnerHandle ? `@${partnerHandle}` : partner}とピクルスを交換しました</p>
        <p className="exchange-done-meta">
          {shownOccasion && <span className="tag tag-place">{shownOccasion}</span>}
          {phase.exchange && <span>{formatDateTime(phase.exchange.createdAt)}</span>}
        </p>
        <p className="text-muted">この記録は2人それぞれのアカウントに残ります</p>
        {partner && <PartnerMessage partner={partner} sessionId={sessionId} />}
        {partner && <FollowPrompt agent={agent} did={did} partner={partner} handle={partnerHandle} />}
        <Link to="/binder" className="btn btn-primary btn-block exchange-bottom">
          ビンへ
        </Link>
      </div>
    )
  }

  if (rejected) {
    return (
      <>
        {header}
        <p role="alert" className="notice exchange-notice">
          このセッションには入れません（終わったか、参加していません）
        </p>
        <Link to="/exchange" className="btn btn-primary btn-block exchange-bottom">
          もう一度はじめる
        </Link>
      </>
    )
  }

  if (!joined) {
    return (
      <>
        {header}
        {props.waiting}
      </>
    )
  }

  if (phase.kind === 'recording') {
    return (
      <>
        {header}
        <p role="status" className="exchange-progress">
          2人とも確定しました。交換を記録しています…
        </p>
      </>
    )
  }

  if (phase.kind === 'waiting_partner') {
    return (
      <>
        {header}
        <p role="status" className="exchange-progress">
          相手の記録待ち…
        </p>
        <button type="button" className="btn btn-block" onClick={() => void sendCommit(phase.uri)}>
          もう一度確かめる
        </button>
      </>
    )
  }

  if (phase.kind === 'failed') {
    const { uri } = phase
    return (
      <>
        {header}
        <p role="alert" className="notice exchange-notice">
          交換が成立しませんでした：{phase.reason}
        </p>
        {uri ? (
          <button type="button" className="btn btn-primary btn-block" onClick={() => void sendCommit(uri)}>
            もう一度送る
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => {
              recordStarted.current = true
              void record(latest.current.occasion)
            }}
          >
            もう一度記録する
          </button>
        )}
      </>
    )
  }

  return (
    <>
      {headerWith('渡す一枚を選ぶ')}

      <div className="card exchange-partner">
        <div className="exchange-partner-info">
          <span className="exchange-partner-name">
            {partnerDid && <Avatar did={partnerDid} size={31} />}
            {partnerHandle ? `@${partnerHandle}` : (partnerDid ?? '参加しました')}
          </span>
          <span className="exchange-hint">{partnerRef ? '相手はこの1枚を選びました' : '相手が選ぶのを待っています…'}</span>
        </div>
        <div className="exchange-partner-pick">
          {partnerRef && (partnerImage ? <img src={partnerImage} alt="相手が選んだピクルス" /> : <span className="text-muted">読み込み中…</span>)}
        </div>
      </div>

      <h2 className="exchange-mine-title">あなたのピクルス</h2>
      {loadError && <p role="alert">ピクルスを読めませんでした：{loadError}</p>}
      {!myStickers && !loadError && <p className="text-muted">読み込み中…</p>}
      {myStickers?.length === 0 && (
        <p>
          ピクルスがありません。<Link to="/capture">撮影する</Link>
        </p>
      )}
      <div className="exchange-mine">
        {sortedStickers?.map((item) => {
          const isSelected = selected?.uri === item.ref.uri
          const wanted = partnerWants?.has(item.ref.uri) ?? false
          return (
            <button
              key={item.ref.uri}
              type="button"
              className={isSelected ? 'exchange-mine-item selected' : 'exchange-mine-item'}
              onClick={() => select(item.ref)}
              disabled={confirmed}
              aria-pressed={isSelected}
            >
              <img src={item.imageUrl} alt={item.sticker.caption ?? 'ピクルス'} width={IMAGE_SIZE} height={IMAGE_SIZE} />
              {wanted && <span className="tag exchange-wanted">♥ 相手がほしい</span>}
              {isSelected && (
                <span className="exchange-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p className="exchange-hint">渡せるのは自分で作ったピクルスだけです</p>

      <label className="exchange-occasion exchange-message-input">
        相手にひとこと（任意）
        <input type="text" className="input" value={message} onChange={(e) => setMessage(e.target.value)} disabled={confirmed} />
      </label>
      <p className="exchange-occasion-help">
        <span>確定したあとは変えられません</span>
        <span className={messageTooLong ? 'capture-count over' : 'capture-count'}>
          {messageLength}/{MESSAGE_MAX}
        </span>
      </p>

      <p className="exchange-hint exchange-confirm-hint">
        {confirmed ? '相手の確定を待っています…' : '2人とも確定すると交換が成立します'}
      </p>
      <button type="button" className="btn btn-primary btn-block exchange-pick" onClick={confirm} disabled={!selected || !partnerRef || confirmed || messageTooLong}>
        {confirmed ? '確定しました' : 'Pick!'}
      </button>
    </>
  )
}
