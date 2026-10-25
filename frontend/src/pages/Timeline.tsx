// S2 タイムライン。GET /timeline を新しい順に並べ、下までスクロールしたら cursor で続きを読む。
// 前に開いたときの一覧があればまずそれを出し、裏で1ページ目を読み直して差し替える。
import { AtUri, type Agent } from '@atproto/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { getTimeline, type TimelineItem } from '../api/backend.ts'
import { readCache, writeCache } from '../api/screenCache.ts'
import { getSticker } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import Loading from '../components/Loading.tsx'
import PageHeader from '../components/PageHeader.tsx'
import { DisplayName, ProfileAvatar } from '../components/Profile.tsx'
import StickerImage from '../components/StickerImage.tsx'
import WantButton from '../components/WantButton.tsx'
import type { Did, Sticker, StrongRef } from '../lexicon-types.ts'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function stickerPath(uri: string): string {
  const at = new AtUri(uri)
  return `/sticker/${encodeURIComponent(at.host)}/${encodeURIComponent(at.rkey)}`
}

/** 「10分前」「3時間前」「2日前」。1週間より前は日付で出す */
function formatRelative(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}時間前`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}日前`
  return new Date(iso).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
}

/** 交換で渡した・受け取ったステッカー。押すとそのステッカーの詳細へ。削除されて読めなければ枠だけ出す */
function TradeSticker({ sticker }: { sticker: StrongRef }) {
  const [record, setRecord] = useState<Sticker>()

  useEffect(() => {
    let cancelled = false
    getSticker(sticker)
      .then((s) => !cancelled && setRecord(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sticker])

  return (
    <Link to={stickerPath(sticker.uri)} className="timeline-trade-item">
      {record && <StickerImage did={new AtUri(sticker.uri).host} sticker={record} maxHeight={53} />}
    </Link>
  )
}

/** 交換は2人がそれぞれ書くので、2人とも相手にいると同じ交換が2件来る。sessionId で1件にまとめる */
function dedupe(items: TimelineItem[]): TimelineItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (item.kind !== 'exchange') return true
    if (seen.has(item.record.sessionId)) return false
    seen.add(item.record.sessionId)
    return true
  })
}

interface TimelineCache {
  items: TimelineItem[]
  cursor?: string
  done: boolean
}

function Event({ item, agent, me }: { item: TimelineItem; agent: Agent; me: Did }) {
  if (item.kind === 'sticker') {
    const path = stickerPath(item.uri)
    // 「ほしい」はリンクの外に置き、押しても詳細に飛ばないようにする
    return (
      <article className="card timeline-sticker">
        <Link to={path} className="timeline-thumb" tabIndex={-1} aria-hidden="true">
          <StickerImage did={item.author} sticker={item.record} maxHeight={72} />
        </Link>
        <div className="timeline-body">
          <Link to={path} className="timeline-link">
            <span className="timeline-who">
              <ProfileAvatar did={item.author} />
              <span>
                <DisplayName did={item.author} />の
                <br />
                新しいピクルス
              </span>
            </span>
            {item.record.caption && <span className="timeline-caption">{item.record.caption}</span>}
            <span className="text-muted">{formatRelative(item.createdAt)}</span>
            <span className={item.record.source === 'photo' ? 'tag' : 'tag tag-illustration'}>
              {item.record.source === 'photo' ? '写真' : 'イラスト'}
            </span>
          </Link>
          <WantButton agent={agent} did={me} subject={{ uri: item.uri, cid: item.cid }} />
        </div>
      </article>
    )
  }
  return (
    <article className="card timeline-exchange">
      <span className="timeline-who timeline-who-lg">
        <ProfileAvatar did={item.author} size={30} />
        <span>
          <span className="timeline-exchange-title">
            <DisplayName did={item.author} /> が <DisplayName did={item.record.partner} /> と交換しました
          </span>
          <span className="text-muted">{formatRelative(item.createdAt)}</span>
        </span>
      </span>
      {item.record.occasion && <span className="tag tag-place">{item.record.occasion}</span>}
      <div className="timeline-trade">
        <TradeSticker sticker={item.record.gave} />
        <span className="timeline-trade-arrow" aria-hidden="true">
          ⇔
        </span>
        <TradeSticker sticker={item.record.received} />
      </div>
    </article>
  )
}

export default function Timeline() {
  const auth = useAuth()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const cacheKey = auth.status === 'signedIn' ? `timeline:${auth.did}` : undefined

  const [cached] = useState(() => readCache<TimelineCache>(cacheKey))
  const [items, setItems] = useState<TimelineItem[]>(cached?.items ?? [])
  const [cursor, setCursor] = useState<string | undefined>(cached?.cursor)
  const [done, setDone] = useState(cached?.done ?? false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // 前の一覧を読み直している間は、続きを読まない
  const [refreshing, setRefreshing] = useState(cached !== undefined)
  const loadingRef = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    writeCache(cacheKey, { items, cursor, done } satisfies TimelineCache)
  }, [cacheKey, items, cursor, done])

  // 前の一覧を出しているときは、1ページ目を裏で読み直して差し替える。読めなければ前の一覧のまま
  useEffect(() => {
    if (!agent || !cached) return
    let cancelled = false
    getTimeline(agent)
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setCursor(res.cursor ?? undefined)
        setDone(!res.cursor)
      })
      .catch(() => {})
      .finally(() => !cancelled && setRefreshing(false))
    return () => {
      cancelled = true
    }
  }, [agent, cached])

  const loadMore = useCallback(async () => {
    if (!agent || done || loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(undefined)
    try {
      const res = await getTimeline(agent, cursor)
      setItems((prev) => [...prev, ...res.items])
      setCursor(res.cursor ?? undefined)
      if (!res.cursor) setDone(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [agent, cursor, done])

  // 一番下の目印が見えたら続きを読む。読み終わると loadMore が作り直され、まだ見えていればもう一度読む
  useEffect(() => {
    const el = sentinel.current
    if (!el || error || refreshing) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore, error, refreshing])

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut' || !agent) return <Navigate to="/login" replace />

  const shown = dedupe(items)

  return (
    <>
      <PageHeader title="タイムライン" />
      {done && shown.length === 0 && <p style={{ marginTop: 48, textAlign: 'center' }}>交換すると、相手の新しいピクルスがここに流れます</p>}
      <div className="timeline">
        {shown.map((item) => (
          <Event key={item.uri} item={item} agent={agent} me={auth.did} />
        ))}
      </div>
      {loading && (shown.length === 0 ? <Loading /> : <p className="text-muted">読み込み中…</p>)}
      {loading && <BackendWaking />}
      {error && (
        <p role="alert">
          読めませんでした：{error}{' '}
          <button type="button" className="btn" onClick={() => void loadMore()}>
            もう一度
          </button>
        </p>
      )}
      <div ref={sentinel} style={{ height: 1 }} />
    </>
  )
}
