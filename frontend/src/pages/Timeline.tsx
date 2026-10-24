// S2 タイムライン。GET /timeline を新しい順に並べ、下までスクロールしたら cursor で続きを読む。
import { AtUri } from '@atproto/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { getTimeline, type TimelineItem } from '../api/backend.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import Handle from '../components/Handle.tsx'
import StickerImage, { StickerBackdrop } from '../components/StickerImage.tsx'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function stickerPath(uri: string): string {
  const at = new AtUri(uri)
  return `/sticker/${encodeURIComponent(at.host)}/${encodeURIComponent(at.rkey)}`
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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

function Event({ item }: { item: TimelineItem }) {
  const card = { display: 'block', padding: 12, marginBottom: 12, borderRadius: 12, background: 'rgba(255,255,255,0.6)', color: 'inherit', textDecoration: 'none' }
  if (item.kind === 'sticker') {
    return (
      <Link to={stickerPath(item.uri)} style={card}>
        <p style={{ margin: '0 0 8px' }}>
          <Handle did={item.author} /> さんが新しいステッカーを作りました
        </p>
        <StickerImage did={item.author} sticker={item.record} maxHeight={240} />
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#888' }}>{formatDateTime(item.createdAt)}</p>
      </Link>
    )
  }
  return (
    <Link to={stickerPath(item.record.gave.uri)} style={card}>
      <p style={{ margin: 0 }}>
        <Handle did={item.author} /> さんと <Handle did={item.record.partner} /> さんが交換しました
        {item.record.occasion ? `（${item.record.occasion}）` : ''}
      </p>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: '#888' }}>{formatDateTime(item.createdAt)}</p>
    </Link>
  )
}

export default function Timeline() {
  const auth = useAuth()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined

  const [items, setItems] = useState<TimelineItem[]>([])
  const [cursor, setCursor] = useState<string>()
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const loadingRef = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)

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
    if (!el || error) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore, error])

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  const shown = dedupe(items)

  return (
    <StickerBackdrop>
      <h1 style={{ fontSize: 20 }}>タイムライン</h1>
      {done && shown.length === 0 && <p style={{ marginTop: 48, textAlign: 'center' }}>交換すると、相手の新しいステッカーがここに流れます</p>}
      {shown.map((item) => (
        <Event key={item.uri} item={item} />
      ))}
      {loading && <p>読み込み中…</p>}
      {loading && <BackendWaking />}
      {error && (
        <p role="alert">
          読めませんでした：{error}{' '}
          <button type="button" onClick={() => void loadMore()}>
            もう一度
          </button>
        </p>
      )}
      <div ref={sentinel} style={{ height: 1 }} />
    </StickerBackdrop>
  )
}
