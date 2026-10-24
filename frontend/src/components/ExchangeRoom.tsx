// 対面交換の「選ぶ → 確定 → 記録」（spec 6章の3〜8）。始めた人・参加した人の両方がこの画面を使う。
import { AtUri, type Agent } from '@atproto/api'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  commitExchange,
  openExchangeSocket,
  type CommitResponse,
  type ExchangeSocket,
  type ExchangeView,
  type ServerMessage,
} from '../api/backend.ts'
import { getSticker, resolveDid, stickerImageUrl } from '../api/sticker.ts'
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
  const [partnerRef, setPartnerRef] = useState<StrongRef>()
  const [partnerImage, setPartnerImage] = useState<string>()
  const [partnerHandle, setPartnerHandle] = useState<string>()
  const [rejected, setRejected] = useState(false)

  const socketRef = useRef<ExchangeSocket>(undefined)
  // WebSocket のハンドラから最新の値を読むための写し
  const latest = useRef({ selected, partnerRef, occasion })
  useLayoutEffect(() => {
    latest.current = { selected, partnerRef, occasion }
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
    if (!gave || !received) {
      setPhase({ kind: 'failed', reason: '選んだステッカーが分からなくなりました' })
      return
    }
    setPhase({ kind: 'recording' })
    try {
      const value: Exchange = {
        $type: NSID.exchange,
        sessionId,
        // サーバーのセッションの値をそのまま入れる。無ければ書かない
        ...(messageOccasion ? { occasion: messageOccasion } : {}),
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

  function confirm() {
    if (!selected) return
    setConfirmed(true)
    socketRef.current?.send({ type: 'confirm' })
  }

  const header = (
    <>
      <h1>対面交換</h1>
      {occasion && <p>場面：{occasion}</p>}
    </>
  )

  if (phase.kind === 'cancelled') {
    return (
      <>
        {header}
        <p role="alert">キャンセルされました</p>
        <p>{phase.reason}</p>
        <Link to="/exchange">もう一度はじめる</Link>
      </>
    )
  }

  if (phase.kind === 'completed') {
    const partner = phase.exchange?.partner ?? partnerDid
    const shownOccasion = phase.exchange ? phase.exchange.occasion : occasion
    return (
      <>
        <h1>交換成立</h1>
        <p>相手：{partnerHandle ? `@${partnerHandle}` : partner}</p>
        <p>場面：{shownOccasion || '（なし）'}</p>
        {partnerImage && <img src={partnerImage} alt="受け取ったステッカー" width={IMAGE_SIZE * 2} />}
        <p>
          <Link to="/binder">シール帳へ</Link>
        </p>
      </>
    )
  }

  if (rejected) {
    return (
      <>
        {header}
        <p role="alert">このセッションには入れません（終わったか、参加していません）</p>
        <Link to="/exchange">もう一度はじめる</Link>
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
        <p>2人とも確定しました。交換を記録しています…</p>
      </>
    )
  }

  if (phase.kind === 'waiting_partner') {
    return (
      <>
        {header}
        <p>相手の記録待ち…</p>
        <button type="button" onClick={() => void sendCommit(phase.uri)}>
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
        <p role="alert">交換が成立しませんでした：{phase.reason}</p>
        {uri ? (
          <button type="button" onClick={() => void sendCommit(uri)}>
            もう一度送る
          </button>
        ) : (
          <button
            type="button"
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
      {header}
      <p>相手：{partnerHandle ? `@${partnerHandle}` : (partnerDid ?? '参加しました')}</p>

      <h2>相手が選んだステッカー</h2>
      {partnerRef ? (
        partnerImage ? (
          <img src={partnerImage} alt="相手が選んだステッカー" width={IMAGE_SIZE * 2} />
        ) : (
          <p>読み込み中…</p>
        )
      ) : (
        <p>相手が選ぶのを待っています…</p>
      )}

      <h2>渡すステッカーを1枚選ぶ</h2>
      {loadError && <p role="alert">ステッカーを読めませんでした：{loadError}</p>}
      {!myStickers && !loadError && <p>読み込み中…</p>}
      {myStickers?.length === 0 && (
        <p>
          ステッカーがありません。<Link to="/capture">撮影する</Link>
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {myStickers?.map((item) => {
          const isSelected = selected?.uri === item.ref.uri
          return (
            <button
              key={item.ref.uri}
              type="button"
              onClick={() => select(item.ref)}
              disabled={confirmed}
              aria-pressed={isSelected}
              style={{ padding: 4, border: isSelected ? '3px solid #e91e63' : '3px solid transparent' }}
            >
              <img src={item.imageUrl} alt={item.sticker.caption ?? 'ステッカー'} width={IMAGE_SIZE} height={IMAGE_SIZE} style={{ objectFit: 'contain' }} />
            </button>
          )
        })}
      </div>

      <p>
        <button type="button" onClick={confirm} disabled={!selected || !partnerRef || confirmed}>
          {confirmed ? '確定しました' : '確定'}
        </button>
      </p>
      {confirmed && <p>相手の確定を待っています…</p>}
    </>
  )
}
