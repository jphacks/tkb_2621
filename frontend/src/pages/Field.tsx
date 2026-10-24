// S8 共同フィールド。メンバー全員の field.placement を1枚のキャンバスに重ねる。
// 自分のステッカー（交換で受け取ったものは除く）だけを貼れ、動かし終わって1秒たったら自分の field.placement を書き直す。
// 他のメンバーの貼り付け・移動・削除は Jetstream（api/fieldLive.ts）でその場に反映する。
import { AtUri } from '@atproto/api'
import QRCode from 'qrcode'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { getFieldMembers, joinField } from '../api/backend.ts'
import { centerPlacement, listOwnRecords } from '../api/binder.ts'
import {
  createFieldPlacement,
  getField,
  inviteUrl,
  isMember,
  listFieldItems,
  loadFieldItem,
  putFieldPlacement,
  toPlacementOnly,
  type FieldItem,
  type FieldView,
} from '../api/field.ts'
import { subscribeFieldPlacements } from '../api/fieldLive.ts'
import { resolveDid, stickerImageUrl } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import BinderCanvas, { type CanvasItem } from '../components/BinderCanvas.tsx'
import WantButton from '../components/WantButton.tsx'
import { NSID, type Did, type FieldPlacement, type Placement, type StrongRef, type Sticker } from '../lexicon-types.ts'

const SAVE_DELAY_MS = 1000
// Jetstream の取りこぼし（切れていたあいだ・署名を確かめていない中身）を PDS から読み直して正す間隔
const REFRESH_INTERVAL_MS = 30_000
// 知らない人の貼り付けが来てからメンバー一覧を読み直すまで。続けて来てもまとめて1回にする
const MEMBERS_REFRESH_DELAY_MS = 1000
const THUMB_SIZE = 64

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  pending: '保存待ち…',
  saving: '保存しています…',
  saved: '保存しました',
  error: '保存できませんでした。もう一度動かすと保存し直します',
}

interface MySticker {
  ref: StrongRef
  sticker: Sticker
  imageUrl: string
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function QrCode({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string>()
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(url, { width: 640, margin: 2 })
      .then((d) => !cancelled && setDataUrl(d))
      .catch(() => !cancelled && setDataUrl(undefined))
    return () => {
      cancelled = true
    }
  }, [url])
  if (!dataUrl) return <p>QR を作っています…</p>
  return <img src={dataUrl} alt="招待用の QR コード" style={{ width: '100%', maxWidth: 360, imageRendering: 'pixelated' }} />
}

function maxZ(list: FieldItem[]): number {
  return list.reduce((m, item) => Math.max(m, item.placement.z), -1)
}

/**
 * 読み直した結果を画面の状態に混ぜる。自分の貼り付けは画面の状態が正（保存待ちの動きを消さない）。
 * 読み始めたあとに Jetstream で変わった（消えた）ものも、画面の状態を残す。
 */
function mergeItems(current: FieldItem[] | undefined, fresh: FieldItem[], me: Did, started: number, touched: Map<string, number>): FieldItem[] {
  if (!current) return fresh
  const keepLocal = (item: FieldItem) => item.author === me || (touched.get(item.uri) ?? 0) >= started
  const local = new Map(current.map((item) => [item.uri, item]))
  const freshUris = new Set(fresh.map((item) => item.uri))
  const out: FieldItem[] = []
  for (const item of fresh) {
    if (!keepLocal(item)) {
      out.push(item)
      continue
    }
    // 自分のものでも、画面に無いもの（別の端末で貼ったもの）は足す
    const kept = local.get(item.uri) ?? (item.author === me ? item : undefined)
    if (kept) out.push(kept)
  }
  for (const item of current) {
    if (!freshUris.has(item.uri) && keepLocal(item)) out.push(item)
  }
  return out
}

export default function Field() {
  const auth = useAuth()
  const navigate = useNavigate()
  const { did: creator = '', rkey = '' } = useParams()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const me = auth.status === 'signedIn' ? auth.did : undefined
  const fieldUri = `at://${creator}/${NSID.field}/${rkey}`

  const [field, setField] = useState<FieldView>()
  const [member, setMember] = useState<boolean>()
  const [members, setMembers] = useState<Did[]>()
  const [membersError, setMembersError] = useState<string>()
  const [handles, setHandles] = useState<Record<Did, string>>({})
  const [items, setItems] = useState<FieldItem[]>()
  const [mine, setMine] = useState<MySticker[]>()
  const [error, setError] = useState<string>()
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [pasting, setPasting] = useState(false)
  const [tapped, setTapped] = useState<FieldItem>()
  const [showInvite, setShowInvite] = useState(false)

  // ---- 読み込み（開いたとき・30秒ごと・Jetstream をつなぎ直したとき・画面に戻ったとき） ----
  const fieldRef = useRef<FieldView | undefined>(undefined)
  const joinedRef = useRef(false)
  const membersRef = useRef(new Set<Did>())
  const itemsRef = useRef<FieldItem[] | undefined>(undefined)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  // Jetstream で変わった時刻。それより前に読み始めた PDS の結果で、新しい内容を古い内容に戻さない
  const touched = useRef(new Map<string, number>())

  const refresh = useCallback(
    async (isCancelled: () => boolean) => {
      const f = fieldRef.current
      if (!agent || !me || !f) return
      const joined = joinedRef.current
      const started = Date.now()
      let fromServer: Did[] = []
      try {
        fromServer = (await getFieldMembers(agent, fieldUri)).members
        // 自分の PDS では参加済みなのにサーバーが知らないときは、開いた時点で参加し直す
        if (joined && !fromServer.includes(me)) fromServer = (await joinField(agent, f.ref)).members
        if (!isCancelled()) setMembersError(undefined)
      } catch (e) {
        // サーバーが読めなくても、自分と作った人の分は出す
        if (!isCancelled()) setMembersError(errorMessage(e))
      }
      const all = [...new Set([f.creator, ...(joined ? [me] : []), ...fromServer])]
      if (isCancelled()) return
      membersRef.current = new Set(all)
      setMembers((prev) => (prev && prev.join() === all.join() ? prev : all))
      const list = await listFieldItems(fieldUri, all)
      if (!isCancelled()) setItems((current) => mergeItems(current, list, me, started, touched.current))
    },
    [agent, me, fieldUri],
  )

  useEffect(() => {
    if (!agent || !me) return
    let cancelled = false
    ;(async () => {
      const f = await getField(fieldUri)
      if (cancelled) return
      fieldRef.current = f
      membersRef.current = new Set()
      touched.current.clear()
      setField(f)
      setItems(undefined)
      const joined = await isMember(agent, me, fieldUri)
      if (cancelled) return
      joinedRef.current = joined
      setMember(joined)
      await refresh(() => cancelled)
    })().catch((e: unknown) => !cancelled && setError(errorMessage(e)))

    listOwnRecords<Sticker>(agent, me, NSID.sticker)
      .then((records) =>
        Promise.all(records.map(async (r) => ({ ref: { uri: r.uri, cid: r.cid }, sticker: r.value, imageUrl: await stickerImageUrl(me, r.value) }))),
      )
      .then((list) => !cancelled && setMine(list))
      .catch(() => !cancelled && setMine([]))
    return () => {
      cancelled = true
    }
  }, [agent, me, fieldUri, refresh])

  // ---- 他のメンバーの変更をその場で反映する（Jetstream）。取りこぼしは30秒ごとの読み直しで埋める ----
  const liveLatest = useRef(new Map<string, FieldPlacement>())
  useEffect(() => {
    if (!field || !me) return
    let stopped = false
    let membersTimer: ReturnType<typeof setTimeout> | undefined
    const reload = () => void refresh(() => stopped).catch(() => undefined)

    const unsubscribe = subscribeFieldPlacements(field.ref.uri, {
      onReconnect: reload,
      onEvent: (event) => {
        // 自分の貼り付けは画面の状態が正（保存待ちの動きを消さない）
        if (event.author === me) return
        touched.current.set(event.uri, Date.now())
        if (event.type === 'delete') {
          setItems((list) => list?.filter((item) => item.uri !== event.uri))
          return
        }
        if (!membersRef.current.has(event.author)) {
          // 新しく参加した人かもしれない。メンバー一覧から読み直す（続けて来てもまとめて1回）
          clearTimeout(membersTimer)
          membersTimer = setTimeout(reload, MEMBERS_REFRESH_DELAY_MS)
          return
        }
        liveLatest.current.set(event.uri, event.value)
        const old = itemsRef.current?.find((item) => item.uri === event.uri)
        if (old && old.placement.sticker.uri === event.value.sticker.uri && old.placement.sticker.cid === event.value.sticker.cid) {
          const placement = toPlacementOnly(event.value)
          setItems((list) => list?.map((item) => (item.uri === event.uri ? { ...item, placement } : item)))
          return
        }
        // 新しく貼られた（または貼り替えた）ものは画像を読んでから出す
        void loadFieldItem(event.uri, event.author, event.value).then((item) => {
          // 読んでいるあいだにさらに新しい変更が来ていれば、そちらに任せる
          if (stopped || liveLatest.current.get(event.uri) !== event.value) return
          setItems((list) => list && [...list.filter((i) => i.uri !== event.uri), item])
        })
      },
    })

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, REFRESH_INTERVAL_MS)
    // iPhone は裏に回ると接続が切れるので、戻ったときに読み直す
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(membersTimer)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [field, me, refresh])

  // メンバーのハンドル
  useEffect(() => {
    if (!members) return
    let cancelled = false
    for (const d of members) {
      resolveDid(d)
        .then((info) => !cancelled && info.handle && setHandles((h) => ({ ...h, [d]: info.handle as string })))
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [members])

  // ---- 保存（最後に動かしてから1秒後。画面を閉じるときはすぐ） ----
  const pending = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!agent || !me || !field || pending.current.size === 0) return
    const uris = [...pending.current]
    pending.current.clear()
    setSaveState('saving')
    const results = await Promise.all(
      uris.map(async (uri) => {
        const item = itemsRef.current?.find((i) => i.uri === uri)
        if (!item) return true
        try {
          await putFieldPlacement(agent, me, uri, field.ref, item.placement, item.createdAt)
          return true
        } catch {
          // 次の変更や画面を閉じるときに保存し直す
          pending.current.add(uri)
          return false
        }
      }),
    )
    setSaveState(results.every(Boolean) ? (pending.current.size > 0 ? 'pending' : 'saved') : 'error')
  }, [agent, me, field])

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

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  function update(uri: string, next: FieldItem[]) {
    setItems(next)
    pending.current.add(uri)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
    setSaveState('pending')
  }

  function bringToFront(uri: string) {
    if (!items) return
    const target = items.find((item) => item.uri === uri)
    const top = maxZ(items)
    if (!target || target.author !== me) return
    if (target.placement.z === top && items.filter((i) => i.placement.z === top).length === 1) return
    update(uri, items.map((item) => (item.uri === uri ? { ...item, placement: { ...item.placement, z: top + 1 } } : item)))
  }

  function move(uri: string, placement: Placement) {
    if (!items || items.find((item) => item.uri === uri)?.author !== me) return
    update(uri, items.map((item) => (item.uri === uri ? { ...item, placement } : item)))
  }

  async function paste(sticker: MySticker) {
    if (!agent || !me || !field || !items) return
    setPasting(true)
    setSaveState('saving')
    try {
      const placement = centerPlacement(sticker.ref, maxZ(items) + 1)
      const { uri, createdAt } = await createFieldPlacement(agent, me, field.ref, placement)
      setItems((list) => [
        ...(list ?? []),
        { uri, author: me, placement, createdAt, imageUrl: sticker.imageUrl, width: sticker.sticker.width, height: sticker.sticker.height },
      ])
      setSaveState('saved')
    } catch (e) {
      setError(`貼れませんでした：${errorMessage(e)}`)
      setSaveState('idle')
    } finally {
      setPasting(false)
    }
  }

  function nameOf(d: Did): string {
    return handles[d] ? `@${handles[d]}` : d
  }

  const canvasItems: CanvasItem[] | undefined = items?.map((item) => ({
    id: item.uri,
    placement: item.placement,
    imageUrl: item.imageUrl,
    width: item.width,
    height: item.height,
    locked: item.author !== me,
  }))

  const joinPath = field ? `/fields/join?${new URLSearchParams({ uri: field.ref.uri, cid: field.ref.cid })}` : undefined

  return (
    <>
      <p style={{ margin: 0 }}>
        <Link to="/fields">← 一覧</Link>
      </p>
      <h1>{field?.title ?? '共同フィールド'}</h1>

      {error && <p role="alert">{error}</p>}
      {membersError && <small role="alert">メンバーの一部が読めませんでした（{membersError}）</small>}
      <BackendWaking />

      {member === false && joinPath && (
        <p>
          まだ参加していません。<Link to={joinPath}>参加する</Link>
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setShowInvite((v) => !v)} disabled={!field}>
          {showInvite ? '招待 QR を閉じる' : '招待 QR'}
        </button>
        <small role="status">{SAVE_LABEL[saveState]}</small>
      </div>

      {showInvite && field && (
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <QrCode url={inviteUrl(field.ref)} />
          <p style={{ fontSize: 12 }}>iPhone のカメラで読むと参加できます</p>
        </div>
      )}

      {canvasItems ? (
        <BinderCanvas
          items={canvasItems}
          onFront={bringToFront}
          onChange={move}
          onTapLocked={(uri) => setTapped(items?.find((item) => item.uri === uri))}
        />
      ) : (
        !error && <p>読み込み中…</p>
      )}

      {tapped && (
        <div role="dialog" style={{ border: '1px solid #ddd', borderRadius: 8, padding: 8, margin: '8px 0', background: '#fff' }}>
          <p style={{ margin: '0 0 8px' }}>
            {nameOf(tapped.author)} のステッカーです。交換すると自分のシール帳に貼れます
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {agent && me && <WantButton key={tapped.uri} agent={agent} did={me} subject={tapped.placement.sticker} />}
            <button type="button" onClick={() => navigate('/exchange')}>
              交換する
            </button>
            <button type="button" onClick={() => navigate(`/sticker/${encodeURIComponent(tapped.author)}/${encodeURIComponent(new AtUri(tapped.placement.sticker.uri).rkey)}`)}>
              詳細
            </button>
            <button type="button" onClick={() => setTapped(undefined)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      <h2 style={{ fontSize: 14, margin: '8px 0' }}>メンバー（{members?.length ?? '…'}）</h2>
      <p style={{ fontSize: 12, margin: 0 }}>{members?.map(nameOf).join('、')}</p>

      {member && (
        <div style={{ position: 'sticky', bottom: 0, background: '#fff', paddingTop: 8 }}>
          <h2 style={{ fontSize: 14, margin: '8px 0' }}>自分のステッカー（タップで中央に貼る）</h2>
          {!mine && <p>読み込み中…</p>}
          {mine?.length === 0 && <p>まだステッカーがありません。撮影から作れます</p>}
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
            {mine?.map((sticker) => (
              <button
                key={sticker.ref.uri}
                type="button"
                onClick={() => void paste(sticker)}
                disabled={!items || pasting}
                style={{ flex: '0 0 auto', padding: 4, background: 'none', border: '1px solid #ddd', borderRadius: 8 }}
              >
                <img src={sticker.imageUrl} alt={sticker.sticker.caption ?? 'ステッカー'} width={THUMB_SIZE} height={THUMB_SIZE} style={{ objectFit: 'contain' }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
