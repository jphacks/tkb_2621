// S8 共同フィールド。メンバー全員の field.placement を1枚のキャンバスに重ねる。
// 手持ちのステッカー（自分のもの＋成立した交換で受け取ったもの）を貼れ、動かし終わって1秒たったら自分の field.placement を書き直す。
// 他のメンバーの貼り付け・移動・削除は Jetstream（api/fieldLive.ts）でその場に反映する。
// 自分の貼り付けは選んで角の × で消せる。作った人は「フィールドを削除」、それ以外は「抜ける」。
import { AtUri } from '@atproto/api'
import QRCode from 'qrcode'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { BackendError, getFieldMembers, joinField } from '../api/backend.ts'
import { centerPlacement, listOwnedStickers, type OwnedSticker } from '../api/binder.ts'
import {
  FieldDeletedError,
  createFieldPlacement,
  deleteField,
  deleteFieldPlacement,
  getField,
  inviteUrl,
  isMember,
  leaveField,
  listFieldItems,
  loadFieldItem,
  putFieldPlacement,
  removeOwnFieldRecords,
  toPlacementOnly,
  type FieldItem,
  type FieldView,
} from '../api/field.ts'
import { subscribeFieldPlacements } from '../api/fieldLive.ts'
import { resolveDid } from '../api/sticker.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import Handle from '../components/Handle.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import BinderCanvas, { type CanvasItem } from '../components/BinderCanvas.tsx'
import Loading from '../components/Loading.tsx'
import { DisplayName, ProfileAvatar } from '../components/Profile.tsx'
import WantButton from '../components/WantButton.tsx'
import { NSID, PLACEMENT_LIMITS, type Did, type FieldPlacement, type Placement } from '../lexicon-types.ts'

const SAVE_DELAY_MS = 1000
// Jetstream の取りこぼし（切れていたあいだ・署名を確かめていない中身）を PDS から読み直して正す間隔
const REFRESH_INTERVAL_MS = 30_000
// 知らない人の貼り付けが来てからメンバー一覧を読み直すまで。続けて来てもまとめて1回にする
const MEMBERS_REFRESH_DELAY_MS = 1000
const THUMB_SIZE = 48

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  pending: '保存待ち…',
  saving: '保存しています…',
  saved: '保存しました',
  error: '保存できませんでした。もう一度動かすと保存し直します',
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
  return <img src={dataUrl} alt="招待用の QR コード" className="exchange-qr-image" />
}

function maxZ(list: FieldItem[]): number {
  return list.reduce((m, item) => Math.max(m, item.placement.z), -1)
}

/**
 * 読み直した結果を画面の状態に混ぜる。自分の貼り付けは画面の状態が正（保存待ちの動きを消さない）。
 * 読み始めたあとに Jetstream で変わった（消えた）ものも、画面の状態を残す。
 */
function mergeItems(
  current: FieldItem[] | undefined,
  fetched: FieldItem[],
  me: Did,
  started: number,
  touched: Map<string, number>,
  removed: Set<string>,
): FieldItem[] {
  // はがしたものは、消す前に読み始めた結果に残っていても戻さない
  const fresh = fetched.filter((item) => !removed.has(item.uri))
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
  const [mine, setMine] = useState<OwnedSticker[]>()
  const [error, setError] = useState<string>()
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [pasting, setPasting] = useState(false)
  const [tapped, setTapped] = useState<FieldItem>()
  const [showInvite, setShowInvite] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  /** field が無い・サーバーで閉じた */
  const [deleted, setDeleted] = useState(false)
  const [busy, setBusy] = useState(false)

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
  // はがした自分の field.placement の URI
  const removed = useRef(new Set<string>())

  const refresh = useCallback(
    async (isCancelled: () => boolean) => {
      const f = fieldRef.current
      if (!agent || !me || !f) return
      const joined = joinedRef.current
      const started = Date.now()
      let fromServer: Did[] = []
      try {
        const res = await getFieldMembers(agent, fieldUri)
        if (res.closed) {
          if (!isCancelled()) setDeleted(true)
          return
        }
        fromServer = res.members
        // 自分の PDS では参加済みなのにサーバーが知らないときは、開いた時点で参加し直す
        if (joined && !fromServer.includes(me)) fromServer = (await joinField(agent, f.ref)).members
        if (!isCancelled()) setMembersError(undefined)
      } catch (e) {
        // 410: 閉じたフィールドには参加し直せない
        if (e instanceof BackendError && e.status === 410) {
          if (!isCancelled()) setDeleted(true)
          return
        }
        // サーバーが読めなくても、自分と作った人の分は出す
        if (!isCancelled()) setMembersError(errorMessage(e))
      }
      const all = [...new Set([f.creator, ...(joined ? [me] : []), ...fromServer])]
      if (isCancelled()) return
      membersRef.current = new Set(all)
      setMembers((prev) => (prev && prev.join() === all.join() ? prev : all))
      const list = await listFieldItems(fieldUri, all)
      if (!isCancelled()) setItems((current) => mergeItems(current, list, me, started, touched.current, removed.current))
    },
    [agent, me, fieldUri],
  )

  useEffect(() => {
    if (!agent || !me) return
    let cancelled = false
    ;(async () => {
      let f: FieldView | undefined
      try {
        f = await getField(fieldUri)
      } catch (e) {
        if (!(e instanceof FieldDeletedError)) throw e
      }
      if (cancelled) return
      setDeleted(!f)
      if (f) {
        fieldRef.current = f
        membersRef.current = new Set()
        touched.current.clear()
        removed.current.clear()
        setField(f)
        setItems(undefined)
      }
      const joined = await isMember(agent, me, fieldUri)
      if (cancelled) return
      joinedRef.current = joined
      setMember(joined)
      if (f) await refresh(() => cancelled)
    })().catch((e: unknown) => !cancelled && setError(errorMessage(e)))

    listOwnedStickers(agent, me)
      .then((list) => !cancelled && setMine(list))
      .catch(() => !cancelled && setMine([]))
    return () => {
      cancelled = true
    }
  }, [agent, me, fieldUri, refresh])

  // ---- 他のメンバーの変更をその場で反映する（Jetstream）。取りこぼしは30秒ごとの読み直しで埋める ----
  const liveLatest = useRef(new Map<string, FieldPlacement>())
  useEffect(() => {
    if (!field || !me || deleted) return
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
          // 貼ってよくないステッカーに貼り替えたものは消す
          setItems((list) => list && [...list.filter((i) => i.uri !== event.uri), ...(item ? [item] : [])])
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
  }, [field, me, deleted, refresh])

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

  // メンバー一覧は、外を押すか Esc で閉じる
  const membersRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showMembers) return
    const onPointerDown = (e: PointerEvent) => {
      if (!membersRoot.current?.contains(e.target as Node)) setShowMembers(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMembers(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [showMembers])

  // タップした他人のピクルスの説明も、外を押すか Esc で閉じる
  // （別の他人のピクルスを押したときは、閉じたあとにそちらの説明が開く）
  const tappedRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!tapped) return
    const onPointerDown = (e: PointerEvent) => {
      if (!tappedRoot.current?.contains(e.target as Node)) setTapped(undefined)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTapped(undefined)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [tapped])

  // ---- 保存（最後に動かしてから1秒後。画面を閉じるときはすぐ） ----
  const pending = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 保存中の書き直し。はがす・抜ける前に終わるのを待つ（消したあとに putRecord で作り直さないため）
  const flushing = useRef<Promise<unknown>>(Promise.resolve())

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!agent || !me || !field || pending.current.size === 0) return
    const uris = [...pending.current]
    pending.current.clear()
    setSaveState('saving')
    const run = Promise.all(
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
    flushing.current = run
    const results = await run
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

  if (auth.status === 'loading') return <Loading />
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

  async function paste(sticker: OwnedSticker) {
    if (!agent || !me || !field || !items) return
    setPasting(true)
    setSaveState('saving')
    try {
      const placement = centerPlacement(sticker.ref, maxZ(items) + 1)
      const { uri, createdAt } = await createFieldPlacement(agent, me, field.ref, placement)
      setItems((list) => [
        ...(list ?? []),
        { uri, author: me, owner: sticker.owner, placement, createdAt, imageUrl: sticker.imageUrl, width: sticker.sticker.width, height: sticker.sticker.height },
      ])
      setSaveState('saved')
    } catch (e) {
      setError(`貼れませんでした：${errorMessage(e)}`)
      setSaveState('idle')
    } finally {
      setPasting(false)
    }
  }

  /** 選んでいる自分の貼り付けを、自分の PDS から消す */
  async function peel() {
    const item = items?.find((i) => i.uri === selectedId && i.author === me)
    if (!agent || !me || !item) return
    setSelectedId(undefined)
    pending.current.delete(item.uri)
    removed.current.add(item.uri)
    setItems((list) => list?.filter((i) => i.uri !== item.uri))
    try {
      await flushing.current
      await deleteFieldPlacement(agent, me, item.uri)
    } catch (e) {
      removed.current.delete(item.uri)
      setItems((list) => list && [...list.filter((i) => i.uri !== item.uri), item])
      setError(`はがせませんでした：${errorMessage(e)}`)
    }
  }

  /** 保存待ちを捨て、保存中のものが終わるのを待つ（このあと自分の field.placement を全部消すため） */
  async function stopSaving() {
    clearTimeout(timer.current)
    pending.current.clear()
    await flushing.current
  }

  async function onLeave() {
    if (!agent || !me || !field) return
    if (!window.confirm(`「${field.title}」から抜けますか？\n自分が貼ったピクルスはこのフィールドから外れます。`)) return
    setBusy(true)
    setError(undefined)
    try {
      await stopSaving()
      await leaveField(agent, me, field)
      navigate('/fields', { replace: true })
    } catch (e) {
      setError(`抜けられませんでした：${errorMessage(e)}`)
      setBusy(false)
    }
  }

  async function onDelete() {
    if (!agent || !me || !field) return
    if (!window.confirm(`「${field.title}」を削除しますか？\nメンバー全員の画面から消え、元に戻せません。`)) return
    setBusy(true)
    setError(undefined)
    try {
      await stopSaving()
      await deleteField(agent, me, field)
      navigate('/fields', { replace: true })
    } catch (e) {
      setError(`削除できませんでした：${errorMessage(e)}`)
      setBusy(false)
    }
  }

  /** 削除されたフィールドの、自分の field.member と field.placement を消す */
  async function onRemoveFromList() {
    if (!agent || !me) return
    setBusy(true)
    setError(undefined)
    try {
      await stopSaving()
      await removeOwnFieldRecords(agent, me, fieldUri)
      navigate('/fields', { replace: true })
    } catch (e) {
      setError(`一覧から外せませんでした：${errorMessage(e)}`)
      setBusy(false)
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

  const header = (
    <>
      <div className="back-header field-header">
        <Link to="/fields" className="icon-button" aria-label="一覧にもどる">
          <img src="/images/back.svg" alt="" width={13} height={18} />
        </Link>
        <h1>{field?.title ?? '共同フィールド'}</h1>
        {member && field && !deleted && (
          <div className="field-manage">
            {field.creator === me ? (
              <button type="button" className="btn" onClick={() => void onDelete()} disabled={busy}>
                {busy ? '削除しています…' : 'フィールドを削除'}
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => void onLeave()} disabled={busy}>
                {busy ? '抜けています…' : '抜ける'}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )

  if (deleted) {
    return (
      <>
        {header}
        <p role="alert" className="notice">
          このフィールドは削除されました
        </p>
        {error && <p role="alert">{error}</p>}
        {member && (
          <button type="button" className="btn btn-block field-remove" onClick={() => void onRemoveFromList()} disabled={busy}>
            {busy ? '外しています…' : '一覧から外す'}
          </button>
        )}
      </>
    )
  }

  const shownMembers = members?.slice(0, 3) ?? []
  const moreMembers = (members?.length ?? 0) - shownMembers.length

  return (
    <>
      {header}

      <div className="field-toolbar">
        <small role="status" className="text-muted">
          {SAVE_LABEL[saveState]}
        </small>
        <div className="field-members-root" ref={membersRoot}>
          <button
            type="button"
            className="field-members"
            onClick={() => setShowMembers((v) => !v)}
            disabled={!members}
            aria-expanded={showMembers}
            aria-label={`メンバー${members?.length ?? ''}人の一覧を${showMembers ? '閉じる' : '出す'}`}
          >
            {shownMembers.map((d) => (
              <ProfileAvatar key={d} did={d} size={28} />
            ))}
            {moreMembers > 0 && <span className="field-members-more">+{moreMembers}</span>}
          </button>
          {showMembers && members && (
            <div className="field-members-panel" role="dialog" aria-label="メンバー一覧">
              <h2>メンバー一覧</h2>
              <ul>
                {members.map((d) => (
                  <li key={d}>
                    {/* Bluesky のプロフィールを別のタブで開く（ステッカー詳細と同じ） */}
                    <a className="field-members-link" href={`https://bsky.app/profile/${d}`} target="_blank" rel="noopener noreferrer">
                      <ProfileAvatar did={d} size={32} />
                      <span className="field-members-name">
                        <DisplayName did={d} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <button
          type="button"
          className="round-button"
          onClick={() => setShowInvite((v) => !v)}
          disabled={!field}
          aria-expanded={showInvite}
          aria-label={showInvite ? '招待 QR を閉じる' : '招待 QR を出す'}
        >
          <img src="/images/scan.svg" alt="" width={12} height={12} />
        </button>
      </div>

      {error && <p role="alert">{error}</p>}
      {membersError && <small role="alert">メンバーの一部が読めませんでした（{membersError}）</small>}
      <BackendWaking />

      {member === false && joinPath && (
        <p className="notice">
          まだ参加していません。<Link to={joinPath}>参加する</Link>
        </p>
      )}

      {showInvite && field && (
        <div className="card exchange-qr field-invite">
          <p>招待 QR</p>
          <QrCode url={inviteUrl(field.ref)} />
          <p className="text-muted">iPhone のカメラで読むと参加できます</p>
        </div>
      )}

      {/* タップした他人のピクルスの説明はキャンバスに重ねる（キャンバスの高さを減らさない） */}
      <div className="field-stage">
        {canvasItems ? (
          <BinderCanvas
            items={canvasItems}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id)
              if (id) setTapped(undefined)
            }}
            onFront={bringToFront}
            onChange={move}
            onPeel={() => void peel()}
            onTapLocked={(uri) => setTapped(items?.find((item) => item.uri === uri))}
            board
          />
        ) : (
          !error && <Loading />
        )}

        {tapped && (
          // 下半分のピクルスなら説明を上端に出し、タップしたピクルスを隠さない
          <div ref={tappedRoot} role="dialog" className={tapped.placement.y > PLACEMENT_LIMITS.position.full / 2 ? 'card field-tapped field-tapped-top' : 'card field-tapped'}>
            <p>
              {tapped.owner === tapped.author ? (
                <>{nameOf(tapped.author)} のピクルスです。</>
              ) : (
                <>
                  <Handle did={tapped.owner} /> のピクルスです（{nameOf(tapped.author)} が交換で受け取って貼りました）。
                </>
              )}
              交換すると自分のビンに貼れます
            </p>
            <div className="field-tapped-actions">
              {agent && me && <WantButton key={tapped.uri} agent={agent} did={me} subject={tapped.placement.sticker} />}
              <button type="button" className="btn btn-primary" onClick={() => navigate('/exchange')}>
                交換する
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => navigate(`/sticker/${encodeURIComponent(tapped.owner)}/${encodeURIComponent(new AtUri(tapped.placement.sticker.uri).rkey)}`)}
              >
                詳細
              </button>
            </div>
          </div>
        )}
      </div>

      {member && (
        <div className="binder-dock">
          <div className="binder-hand-header">
            <h2 className="section-title">手持ちのピクルス</h2>
            {mine && mine.length > 0 && <span className="binder-hand-hint">{mine.length}枚・タップして貼る</span>}
          </div>
          {!mine && <p className="text-muted">読み込み中…</p>}
          {mine?.length === 0 && <p className="text-muted">まだピクルスがありません。撮影から作れます</p>}
          <div className="binder-hand">
            {mine?.map((sticker) => (
              <button key={sticker.ref.uri} type="button" className="binder-hand-item" onClick={() => void paste(sticker)} disabled={!items || pasting}>
                <img src={sticker.imageUrl} alt={sticker.sticker.caption ?? 'ピクルス'} width={THUMB_SIZE} height={THUMB_SIZE} />
                {/* 交換でもらったものには、くれた人のアイコンを付ける */}
                {sticker.owner !== me && (
                  <span className="binder-hand-owner">
                    <ProfileAvatar did={sticker.owner} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
