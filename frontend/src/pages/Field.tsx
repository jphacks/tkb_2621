// S8 共同フィールド。メンバー全員の field.placement を1枚のキャンバスに重ねる。
// 自分のステッカー（交換で受け取ったものは除く）だけを貼れ、動かし終わって1秒たったら自分の field.placement を書き直す。
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
  putFieldPlacement,
  type FieldItem,
  type FieldView,
} from '../api/field.ts'
import { resolveDid, stickerImageUrl } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import BinderCanvas, { type CanvasItem } from '../components/BinderCanvas.tsx'
import { NSID, type Did, type Placement, type StrongRef, type Sticker } from '../lexicon-types.ts'

const SAVE_DELAY_MS = 1000
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

  // ---- 読み込み ----
  useEffect(() => {
    if (!agent || !me) return
    let cancelled = false
    ;(async () => {
      const f = await getField(fieldUri)
      if (cancelled) return
      setField(f)
      const joined = await isMember(agent, me, fieldUri)
      if (cancelled) return
      setMember(joined)
      let fromServer: Did[] = []
      try {
        fromServer = (await getFieldMembers(agent, fieldUri)).members
        // 自分の PDS では参加済みなのにサーバーが知らないときは、開いた時点で参加し直す
        if (joined && !fromServer.includes(me)) fromServer = (await joinField(agent, f.ref)).members
      } catch (e) {
        // サーバーが読めなくても、自分と作った人の分は出す
        if (!cancelled) setMembersError(errorMessage(e))
      }
      const all = [...new Set([f.creator, ...(joined ? [me] : []), ...fromServer])]
      if (cancelled) return
      setMembers(all)
      const list = await listFieldItems(fieldUri, all)
      if (!cancelled) setItems(list)
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
  }, [agent, me, fieldUri])

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
  const itemsRef = useRef<FieldItem[] | undefined>(undefined)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
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
          <div style={{ display: 'flex', gap: 8 }}>
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
