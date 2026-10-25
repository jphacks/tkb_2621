// S4 シール帳。手持ちのステッカーをページに貼り、動かし終わって1秒たったら binder.page に保存する。
// ページごとに漬け液（背景の色）を選べ、配置と一緒に binder.page の brine に保存する。
// 選んだものは角の × でページから外せる（ステッカー本体は消さない）。削除されたステッカーの配置は保存のときに落とす。
// 手持ちのステッカーは長押しするとステッカー詳細へ跳ぶ。
// 前に開いたときの手持ちと配置があればまずそれを出し、裏で読み直す。
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { AtUri } from '@atproto/api'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { BRINES, centerPlacement, findDeletedStickers, getPage, listOwnedStickers, listPageNumbers, putPage, toBrine, type Brine, type OwnedSticker } from '../api/binder.ts'
import { readCache, writeCache } from '../api/screenCache.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import { ProfileAvatar } from '../components/Profile.tsx'
import BinderCanvas, { type CanvasItem } from '../components/BinderCanvas.tsx'
import { SHARE_TEXT, SHARE_URL, renderBinderPage } from '../components/binderShareImage.ts'
import Loading from '../components/Loading.tsx'
import type { Placement } from '../lexicon-types.ts'

const SAVE_DELAY_MS = 1000
const THUMB_SIZE = 48
const LONG_PRESS_MS = 500
/** これより指が動いたら長押しをやめる（手持ちの列を横にスクロールしているとき） */
const LONG_PRESS_SLOP_PX = 10

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
/** ready：画像はできたが、共有シートを開けなかった（もう一度押すと開く） */
type ShareState = 'idle' | 'making' | 'ready'

interface PageItem {
  id: string
  placement: Placement
}

let nextId = 0
function newId(): string {
  nextId += 1
  return `p${nextId}`
}

function toItems(placements: Placement[] | undefined): PageItem[] | undefined {
  return placements?.map((placement) => ({ id: newId(), placement }))
}

function pageCacheKey(did: string | undefined, page: number | undefined): string | undefined {
  return did && page !== undefined ? `binder-page:${did}:${page}` : undefined
}

function brineCacheKey(did: string | undefined, page: number | undefined): string | undefined {
  return did && page !== undefined ? `binder-brine:${did}:${page}` : undefined
}

const BRINE_LABEL: Record<Brine, string> = {
  dill: 'ディル',
  ume: '梅',
  beet: 'ビーツ',
  curry: 'カレー',
}

function stickerPath(uri: string): string {
  const at = new AtUri(uri)
  return `/sticker/${encodeURIComponent(at.host)}/${encodeURIComponent(at.rkey)}`
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
  const navigate = useNavigate()

  const [owned, setOwned] = useState(() => readCache<OwnedSticker[]>(did && `binder-owned:${did}`))
  const [ownedError, setOwnedError] = useState<string>()
  const [pages, setPages] = useState(() => readCache<number[]>(did && `binder-pages:${did}`))
  const [pageIndex, setPageIndex] = useState(0)
  const [items, setItems] = useState(() => toItems(readCache<Placement[]>(pageCacheKey(did, pages?.[0]))))
  // 保存されている漬け液の値のまま（無ければ undefined。表示は toBrine で dill になる）
  const [brine, setBrine] = useState(() => readCache<string>(brineCacheKey(did, pages?.[0])))
  const [pageError, setPageError] = useState<string>()
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [selectedId, setSelectedId] = useState<string>()
  const [shareState, setShareState] = useState<ShareState>('idle')
  const [shareError, setShareError] = useState<string>()
  // 作った画像。共有が「ボタンを押した直後でない」と断られたら、次に押したときこれをそのまま渡す
  const shareFile = useRef<File | undefined>(undefined)

  const page = pages?.[pageIndex]

  // 削除された（RecordNotFound の）ステッカーの URI。その配置は保存のときに落とす
  const deletedStickers = useRef(new Set<string>())
  // 前の配置を出している間に貼った・動かした。読み直した配置でそれを上書きしない
  const touched = useRef(false)

  useEffect(() => {
    if (did && pages) writeCache(`binder-pages:${did}`, pages)
  }, [did, pages])

  useEffect(() => {
    if (!items) return
    writeCache(pageCacheKey(did, page), items.map((item) => item.placement))
    writeCache(brineCacheKey(did, page), brine)
  }, [did, page, items, brine])

  // ---- 保存（最後に動かしてから1秒後。ページを替える・アプリを閉じるときはすぐ） ----
  const pending = useRef<{ page: number; placements: Placement[]; brine?: string } | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const job = pending.current
    if (!job || !agent || !did) return
    pending.current = undefined
    setSaveState('saving')
    try {
      await putPage(agent, did, job.page, job.placements, job.brine)
      setSaveState((s) => (pending.current ? s : 'saved'))
    } catch {
      // 新しい変更が無ければ、次の変更や画面を閉じるときに保存し直す
      pending.current ??= job
      setSaveState('error')
    }
  }, [agent, did])

  function schedule(pageNumber: number, next: PageItem[], nextBrine: string | undefined) {
    pending.current = {
      page: pageNumber,
      placements: next.map((item) => item.placement).filter((p) => !deletedStickers.current.has(p.sticker.uri)),
      brine: nextBrine,
    }
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
      .then((list) => {
        writeCache(`binder-owned:${did}`, list)
        if (!cancelled) setOwned(list)
      })
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
      .then(({ placements, brine: savedBrine }) => {
        if (cancelled) return
        if (!touched.current) {
          setItems(toItems(placements))
          setBrine(savedBrine)
        }
        // 表示とは別に、ステッカーが削除されたかを確かめておく（一時的に読めないだけのものは残す）
        void findDeletedStickers(placements.map((p) => p.sticker)).then((uris) => uris.forEach((uri) => deletedStickers.current.add(uri)))
      })
      .catch((e: unknown) => !cancelled && setPageError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, did, page])

  const press = useRef<{ timer: number; x: number; y: number }>(undefined)
  // 長押しが成立した直後に来る click で貼らないようにする
  const longPressed = useRef(false)

  useEffect(() => () => window.clearTimeout(press.current?.timer), [])

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  function update(next: PageItem[]) {
    if (page === undefined) return
    touched.current = true
    shareFile.current = undefined
    setShareState('idle')
    setItems(next)
    schedule(page, next, brine)
  }

  /** 漬け液を替える。配置はそのままで、配置を動かしたときと同じく1秒後に保存する */
  function chooseBrine(next: Brine) {
    if (page === undefined || !items || next === toBrine(brine)) return
    touched.current = true
    shareFile.current = undefined
    setShareState('idle')
    setBrine(next)
    schedule(page, items, next)
  }

  function maxZ(list: PageItem[]): number {
    return list.reduce((m, item) => Math.max(m, item.placement.z), -1)
  }

  function startPress(e: PointerEvent, sticker: OwnedSticker) {
    longPressed.current = false
    window.clearTimeout(press.current?.timer)
    const timer = window.setTimeout(() => {
      press.current = undefined
      longPressed.current = true
      navigate(stickerPath(sticker.ref.uri))
    }, LONG_PRESS_MS)
    press.current = { timer, x: e.clientX, y: e.clientY }
  }

  function movePress(e: PointerEvent) {
    if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > LONG_PRESS_SLOP_PX) cancelPress()
  }

  function cancelPress() {
    window.clearTimeout(press.current?.timer)
    press.current = undefined
  }

  function paste(sticker: OwnedSticker) {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
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

  /** 選んでいるものをページから外す。ステッカー本体と手持ちの一覧はそのまま */
  function peel() {
    if (!items || !selectedId) return
    update(items.filter((item) => item.id !== selectedId))
    setSelectedId(undefined)
  }

  /** 今のページを PNG にして、端末の共有シートに渡す。共有できない端末ではダウンロードさせる */
  async function share() {
    if (!canvasItems || page === undefined) return
    setShareError(undefined)
    let file = shareFile.current
    if (!file) {
      setShareState('making')
      try {
        file = new File([await renderBinderPage(canvasItems, toBrine(brine))], `pikkles-bin-${pageIndex + 1}.png`, { type: 'image/png' })
      } catch (e) {
        setShareState('idle')
        setShareError(`画像を作れませんでした：${errorMessage(e)}`)
        return
      }
    }
    shareFile.current = undefined
    setShareState('idle')
    if (!navigator.canShare?.({ files: [file] })) {
      const url = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      return
    }
    try {
      // url は渡さず text に入れる（iOS で files と url を一緒に渡すと、アプリによっては画像が落ちるため）
      await navigator.share({ files: [file], text: `${SHARE_TEXT} ${SHARE_URL}` })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        // 画像を作っている間に、押した直後の扱いが切れた。作った画像をとっておき、もう一度押してもらう
        shareFile.current = file
        setShareState('ready')
        return
      }
      setShareError(`シェアできませんでした：${errorMessage(e)}`)
    }
  }

  function goTo(index: number) {
    void flush()
    touched.current = false
    shareFile.current = undefined
    setShareState('idle')
    setSelectedId(undefined)
    setItems(toItems(readCache<Placement[]>(pageCacheKey(did, pages?.[index]))))
    setBrine(readCache<string>(brineCacheKey(did, pages?.[index])))
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
    touched.current = false
    setPages([...pages, number])
    shareFile.current = undefined
    setShareState('idle')
    setSelectedId(undefined)
    setItems(undefined)
    setBrine(undefined)
    setPageIndex(pages.length)
  }

  const byUri = new Map(owned?.map((s) => [s.ref.uri, s]))
  const canvasItems: CanvasItem[] | undefined =
    items && owned
      ? items.map(({ id, placement }) => {
          const sticker = byUri.get(placement.sticker.uri)
          // 手持ちに無い（削除された・成立していない）ものは描かない。削除されたものの配置は保存のときに落とす
          return { id, placement, imageUrl: sticker?.imageUrl, width: sticker?.sticker.width ?? 1, height: sticker?.sticker.height ?? 1 }
        })
      : undefined

  return (
    <>
      <div className="binder-toolbar">
        <Link to="/exchange" className="btn btn-primary binder-exchange">
          ⇔交換する
        </Link>
        <button
          type="button"
          className="btn btn-primary binder-exchange binder-share"
          onClick={() => void share()}
          disabled={!canvasItems || shareState === 'making'}
        >
          {shareState === 'making' ? '作っています…' : 'シェア'}
        </button>
        <button type="button" className="round-button" onClick={() => goTo(pageIndex - 1)} disabled={!pages || pageIndex === 0} aria-label="前のページ">
          ←
        </button>
        <span className="binder-page-number">{pages ? `${pageIndex + 1} / ${pages.length}` : '…'}</span>
        <button
          type="button"
          className="round-button"
          onClick={() => goTo(pageIndex + 1)}
          disabled={!pages || pageIndex >= pages.length - 1}
          aria-label="次のページ"
        >
          →
        </button>
        <button type="button" className="round-button round-button-plus" onClick={addPage} disabled={!pages} aria-label="ページを足す">
          +
        </button>
      </div>
      <div className="binder-brine" role="radiogroup" aria-label="漬け液">
        {BRINES.map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            aria-checked={toBrine(brine) === b}
            aria-label={BRINE_LABEL[b]}
            className="binder-brine-option"
            data-brine={b}
            onClick={() => chooseBrine(b)}
            disabled={!items}
          />
        ))}
      </div>

      {pageError && <p role="alert">{pageError}</p>}
      {shareError && <p role="alert">{shareError}</p>}
      {shareState === 'ready' && (
        <p role="status" className="text-muted">
          画像ができました。もう一度「シェア」を押すと共有できます
        </p>
      )}
      {canvasItems ? (
        <BinderCanvas items={canvasItems} selectedId={selectedId} onSelect={setSelectedId} onFront={bringToFront} onChange={move} onPeel={peel} jar brine={toBrine(brine)} />
      ) : (
        !pageError && <Loading />
      )}
      <small role="status" className="text-muted binder-save-status">
        {SAVE_LABEL[saveState]}
      </small>

      <div className="binder-dock">
        <div className="binder-hand-header">
          <h2 className="section-title">手持ちのピクルス</h2>
          <Link to="/binder/list" className="binder-list-link">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="3.5" height="3.5" />
              <rect x="6" y="0.5" width="3.5" height="3.5" />
              <rect x="0.5" y="6" width="3.5" height="3.5" />
              <rect x="6" y="6" width="3.5" height="3.5" />
            </svg>
            一覧
          </Link>
        </div>
        {ownedError && <p role="alert">手持ちを読めませんでした：{ownedError}</p>}
        {!owned && !ownedError && <p className="text-muted">読み込み中…</p>}
        {owned?.length === 0 && <p className="text-muted">まだピクルスがありません</p>}
        <div className="binder-hand">
          {owned?.map((sticker) => (
            <button
              key={sticker.ref.uri}
              type="button"
              className="binder-hand-item"
              onClick={() => paste(sticker)}
              onPointerDown={(e) => startPress(e, sticker)}
              onPointerMove={movePress}
              onPointerUp={cancelPress}
              onPointerLeave={cancelPress}
              onPointerCancel={cancelPress}
              onContextMenu={(e) => e.preventDefault()}
              disabled={!items}
            >
              <img src={sticker.imageUrl} alt={sticker.sticker.caption ?? 'ピクルス'} width={THUMB_SIZE} height={THUMB_SIZE} draggable={false} />
              {/* 交換でもらったものには、くれた人のアイコンを付ける */}
              {sticker.owner !== did && (
                <span className="binder-hand-owner">
                  <ProfileAvatar did={sticker.owner} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
