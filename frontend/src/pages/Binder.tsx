// S4 シール帳。手持ちのステッカーをページに貼り、動かし終わって1秒たったら binder.page に保存する。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { centerPlacement, getPage, listOwnedStickers, listPageNumbers, putPage, type OwnedSticker } from '../api/binder.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BinderCanvas, { type CanvasItem } from '../components/BinderCanvas.tsx'
import type { Placement } from '../lexicon-types.ts'

const SAVE_DELAY_MS = 1000
const THUMB_SIZE = 64

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

interface PageItem {
  id: string
  placement: Placement
}

let nextId = 0
function newId(): string {
  nextId += 1
  return `p${nextId}`
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  pending: '保存待ち…',
  saving: '保存しています…',
  saved: '保存しました',
  error: '保存できませんでした。もう一度動かすと保存し直します',
}

export default function Binder() {
  const auth = useAuth()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const did = auth.status === 'signedIn' ? auth.did : undefined

  const [owned, setOwned] = useState<OwnedSticker[]>()
  const [ownedError, setOwnedError] = useState<string>()
  const [pages, setPages] = useState<number[]>()
  const [pageIndex, setPageIndex] = useState(0)
  const [items, setItems] = useState<PageItem[]>()
  const [pageError, setPageError] = useState<string>()
  const [saveState, setSaveState] = useState<SaveState>('idle')

  const page = pages?.[pageIndex]

  // ---- 保存（最後に動かしてから1秒後。ページを替える・アプリを閉じるときはすぐ） ----
  const pending = useRef<{ page: number; placements: Placement[] } | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const job = pending.current
    if (!job || !agent || !did) return
    pending.current = undefined
    setSaveState('saving')
    try {
      await putPage(agent, did, job.page, job.placements)
      setSaveState((s) => (pending.current ? s : 'saved'))
    } catch {
      // 新しい変更が無ければ、次の変更や画面を閉じるときに保存し直す
      pending.current ??= job
      setSaveState('error')
    }
  }, [agent, did])

  function schedule(pageNumber: number, next: PageItem[]) {
    pending.current = { page: pageNumber, placements: next.map((item) => item.placement) }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
    setSaveState('pending')
  }

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      void flush()
    }
  }, [flush])

  // ---- 読み込み ----
  useEffect(() => {
    if (!agent || !did) return
    let cancelled = false
    listOwnedStickers(agent, did)
      .then((list) => !cancelled && setOwned(list))
      .catch((e: unknown) => !cancelled && setOwnedError(errorMessage(e)))
    listPageNumbers(agent, did)
      .then((list) => !cancelled && setPages(list))
      .catch((e: unknown) => !cancelled && setPageError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, did])

  useEffect(() => {
    if (!agent || !did || page === undefined) return
    let cancelled = false
    getPage(agent, did, page)
      .then((placements) => !cancelled && setItems(placements.map((placement) => ({ id: newId(), placement }))))
      .catch((e: unknown) => !cancelled && setPageError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, did, page])

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  function update(next: PageItem[]) {
    if (page === undefined) return
    setItems(next)
    schedule(page, next)
  }

  function maxZ(list: PageItem[]): number {
    return list.reduce((m, item) => Math.max(m, item.placement.z), -1)
  }

  function paste(sticker: OwnedSticker) {
    if (!items) return
    update([...items, { id: newId(), placement: centerPlacement(sticker.ref, maxZ(items) + 1) }])
  }

  function bringToFront(id: string) {
    if (!items) return
    const target = items.find((item) => item.id === id)
    const top = maxZ(items)
    if (!target || (target.placement.z === top && items.filter((i) => i.placement.z === top).length === 1)) return
    update(items.map((item) => (item.id === id ? { ...item, placement: { ...item.placement, z: top + 1 } } : item)))
  }

  function move(id: string, placement: Placement) {
    if (!items) return
    update(items.map((item) => (item.id === id ? { ...item, placement } : item)))
  }

  function goTo(index: number) {
    void flush()
    setItems(undefined)
    setPageError(undefined)
    setPageIndex(index)
  }

  async function addPage() {
    if (!pages || !agent || !did) return
    const number = pages[pages.length - 1] + 1
    await flush()
    try {
      // 空のページも保存しておき、開き直したときにページ数が戻るようにする
      await putPage(agent, did, number, [])
    } catch (e) {
      setPageError(`ページを足せませんでした：${errorMessage(e)}`)
      return
    }
    setPages([...pages, number])
    setItems(undefined)
    setPageIndex(pages.length)
  }

  const byUri = new Map(owned?.map((s) => [s.ref.uri, s]))
  const canvasItems: CanvasItem[] | undefined =
    items && owned
      ? items.map(({ id, placement }) => {
          const sticker = byUri.get(placement.sticker.uri)
          // 手持ちに無い（削除された・成立していない）ものは描かない。配置はそのまま残す
          return { id, placement, imageUrl: sticker?.imageUrl, width: sticker?.sticker.width ?? 1, height: sticker?.sticker.height ?? 1 }
        })
      : undefined

  return (
    <>
      <h1>シール帳</h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button type="button" onClick={() => goTo(pageIndex - 1)} disabled={!pages || pageIndex === 0}>
          ← 前
        </button>
        <span>{pages ? `${pageIndex + 1} / ${pages.length}` : '…'}</span>
        <button type="button" onClick={() => goTo(pageIndex + 1)} disabled={!pages || pageIndex >= pages.length - 1}>
          次 →
        </button>
        <button type="button" onClick={addPage} disabled={!pages}>
          ページを足す
        </button>
        <small role="status">{SAVE_LABEL[saveState]}</small>
      </div>

      {pageError && <p role="alert">{pageError}</p>}
      {canvasItems ? (
        <BinderCanvas items={canvasItems} onFront={bringToFront} onChange={move} />
      ) : (
        !pageError && <p>読み込み中…</p>
      )}

      <div style={{ position: 'sticky', bottom: 0, background: '#fff', paddingTop: 8 }}>
        <h2 style={{ fontSize: 14, margin: '8px 0' }}>手持ち（タップでページの中央に貼る）</h2>
        {ownedError && <p role="alert">手持ちを読めませんでした：{ownedError}</p>}
        {!owned && !ownedError && <p>読み込み中…</p>}
        {owned?.length === 0 && <p>まだステッカーがありません</p>}
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
          {owned?.map((sticker) => (
            <button
              key={sticker.ref.uri}
              type="button"
              onClick={() => paste(sticker)}
              disabled={!items}
              style={{ flex: '0 0 auto', padding: 4, background: 'none', border: '1px solid #ddd', borderRadius: 8 }}
            >
              <img src={sticker.imageUrl} alt={sticker.sticker.caption ?? 'ステッカー'} width={THUMB_SIZE} height={THUMB_SIZE} style={{ objectFit: 'contain' }} />
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
