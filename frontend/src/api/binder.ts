// シール帳の読み書き。手持ちのステッカー（自分のもの＋成立した交換で受け取ったもの）と binder.page。
import { AtUri, type Agent } from '@atproto/api'
import { NSID, PLACEMENT_LIMITS, type BinderPage, type Did, type Exchange, type Placement, type StrongRef, type Sticker } from '../lexicon-types.ts'
import { getSticker, resolveDid, stickerImageUrl } from './sticker.ts'

// ---- ページの形と単位 ----

/** ページの縦横比（幅:高さ = 3:4）。x, y はそれぞれ幅・高さを 10000 とした値なので、比は変えない */
export const PAGE_ASPECT = 4 / 3
/** 等倍（scale 1000）のとき、ステッカーの長いほうの辺はページ幅の 1/3 */
export const BASE_SIZE_RATIO = 1 / 3

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 度を -180〜180 の整数にする */
export function normalizeRotation(degrees: number): number {
  const r = ((Math.round(degrees) + 180) % 360 + 360) % 360 - 180
  return r === -180 ? 180 : r
}

/** ページ幅を pageWidth とした座標から、Lexicon の整数の配置にする */
export function toPlacement(
  sticker: StrongRef,
  view: { x: number; y: number; scale: number; rotation: number },
  pageWidth: number,
  z: number,
): Placement {
  const { position, scale } = PLACEMENT_LIMITS
  const pageHeight = pageWidth * PAGE_ASPECT
  return {
    sticker,
    x: clamp((view.x / pageWidth) * position.full, position.min, position.max),
    y: clamp((view.y / pageHeight) * position.full, position.min, position.max),
    scale: clamp(view.scale * scale.unit, scale.min, scale.max),
    rotation: normalizeRotation(view.rotation),
    z: Math.max(0, Math.round(z)),
  }
}

/** Lexicon の配置を、ページ幅を pageWidth とした座標にする */
export function fromPlacement(p: Placement, pageWidth: number) {
  const { position, scale } = PLACEMENT_LIMITS
  return {
    x: (p.x / position.full) * pageWidth,
    y: (p.y / position.full) * pageWidth * PAGE_ASPECT,
    scale: p.scale / scale.unit,
    rotation: p.rotation,
  }
}

/** ページの中央に等倍で、一番上に貼る */
export function centerPlacement(sticker: StrongRef, z: number): Placement {
  const half = PLACEMENT_LIMITS.position.full / 2
  return { sticker, x: half, y: half, scale: PLACEMENT_LIMITS.scale.unit, rotation: 0, z }
}

// ---- 手持ちのステッカー ----

export interface OwnedSticker {
  ref: StrongRef
  owner: Did
  sticker: Sticker
  imageUrl: string
}

export interface ListedRecord<T> {
  uri: string
  cid: string
  value: T
}

/** 自分の PDS のレコードを全部読む */
export async function listOwnRecords<T>(agent: Agent, did: Did, collection: string): Promise<ListedRecord<T>[]> {
  const out: ListedRecord<T>[] = []
  let cursor: string | undefined
  do {
    const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection, limit: 100, cursor })
    out.push(...data.records.map((r) => ({ uri: r.uri, cid: r.cid, value: r.value as unknown as T })))
    cursor = data.records.length > 0 ? data.cursor : undefined
  } while (cursor)
  return out
}

/** 他人の PDS のレコードを全部読む（ログイン不要の公開 API） */
export async function listPublicRecords<T>(did: Did, collection: string): Promise<ListedRecord<T>[]> {
  const { pds } = await resolveDid(did)
  const out: ListedRecord<T>[] = []
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ repo: did, collection, limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`)
    if (!res.ok) throw new Error(`記録が読めません（${res.status}）`)
    const data = (await res.json()) as { records: ListedRecord<T>[]; cursor?: string }
    out.push(...data.records)
    cursor = data.records.length > 0 ? data.cursor : undefined
  } while (cursor)
  return out
}

/** getRecord の失敗が「レコードが無い」（削除された）ものなら true。通信やサーバーの失敗は false */
export async function isRecordNotFound(res: Response): Promise<boolean> {
  const data = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined
  return data?.error === 'RecordNotFound'
}

/**
 * 配置のうち、ステッカーが削除されたもの（PDS が RecordNotFound を返したもの）の URI。
 * 一時的に読めなかっただけのものは含めない（その配置は消さずに残す）
 */
export async function findDeletedStickers(refs: StrongRef[]): Promise<Set<string>> {
  const uris = [...new Set(refs.map((ref) => ref.uri))]
  const deleted = await Promise.all(
    uris.map(async (uri) => {
      try {
        const at = new AtUri(uri)
        const { pds } = await resolveDid(at.host)
        const params = new URLSearchParams({ repo: at.host, collection: at.collection, rkey: at.rkey })
        const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`)
        return !res.ok && (await isRecordNotFound(res))
      } catch {
        return false
      }
    }),
  )
  return new Set(uris.filter((_, i) => deleted[i]))
}

function sameRef(a: StrongRef | undefined, b: StrongRef | undefined): boolean {
  return !!a && !!b && a.uri === b.uri && a.cid === b.cid
}

/**
 * 自分の PDS の exchange のうち、成立したもの。
 * 自分の PDS の記録だけでは成立したか分からない（照合の前に書くので、落ちても残る）。
 * そこで相手の PDS に対になる記録があるものだけを残す（spec 6章の成立条件1〜4と同じ中身）。
 * filter を渡すと、それに合う記録の相手の PDS だけを読む
 */
export async function listEstablishedExchanges(agent: Agent, did: Did, filter?: (exchange: Exchange) => boolean): Promise<Exchange[]> {
  const mine = await listOwnRecords<Exchange>(agent, did, NSID.exchange)
  const byPartner = new Map<Did, Exchange[]>()
  for (const { value } of mine) {
    if (filter && !filter(value)) continue
    const owner = (() => {
      try {
        const uri = new AtUri(value.received.uri)
        return uri.collection === NSID.sticker ? uri.host : undefined
      } catch {
        return undefined
      }
    })()
    // 受け取ったステッカーが相手のものでなければ数えない
    if (!owner || owner !== value.partner) continue
    byPartner.set(value.partner, [...(byPartner.get(value.partner) ?? []), value])
  }

  const established = await Promise.all(
    [...byPartner].map(async ([partner, exchanges]) => {
      let theirs: ListedRecord<Exchange>[]
      try {
        theirs = await listPublicRecords<Exchange>(partner, NSID.exchange)
      } catch {
        // 相手の PDS が読めなければ、その相手の分は出さない
        return []
      }
      return exchanges
        .filter((mineEx) =>
          theirs.some(
            ({ value: t }) =>
              t.sessionId === mineEx.sessionId &&
              t.partner === did &&
              sameRef(t.gave, mineEx.received) &&
              sameRef(t.received, mineEx.gave),
          ),
        )
    }),
  )
  return established.flat()
}

/** 成立した交換で受け取ったステッカーの strongRef */
async function listReceivedRefs(agent: Agent, did: Did): Promise<StrongRef[]> {
  return (await listEstablishedExchanges(agent, did)).map((ex) => ex.received)
}

/** 手持ちのステッカー。strongRef の先が読めない（削除された）ものは出さない */
export async function listOwnedStickers(agent: Agent, did: Did): Promise<OwnedSticker[]> {
  const [own, received] = await Promise.all([listOwnRecords<Sticker>(agent, did, NSID.sticker), listReceivedRefs(agent, did)])

  const mineItems = await Promise.all(
    own.map(async (r) => ({ ref: { uri: r.uri, cid: r.cid }, owner: did, sticker: r.value, imageUrl: await stickerImageUrl(did, r.value) })),
  )

  const seen = new Set(mineItems.map((item) => item.ref.uri))
  const unique = received.filter((ref) => !seen.has(ref.uri) && seen.add(ref.uri))
  const receivedItems = await Promise.all(
    unique.map(async (ref): Promise<OwnedSticker | undefined> => {
      try {
        const owner = new AtUri(ref.uri).host
        const sticker = await getSticker(ref)
        return { ref, owner, sticker, imageUrl: await stickerImageUrl(owner, sticker) }
      } catch {
        return undefined
      }
    }),
  )

  return [...mineItems, ...receivedItems.filter((item): item is OwnedSticker => item !== undefined)]
}

// ---- ページ ----

/** 保存済みのページ番号（小さい順）。1ページも無ければ [1] */
export async function listPageNumbers(agent: Agent, did: Did): Promise<number[]> {
  const records = await listOwnRecords<BinderPage>(agent, did, NSID.binderPage)
  const numbers = records
    .map((r) => Number(new AtUri(r.uri).rkey))
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b)
  return numbers.length > 0 ? numbers : [1]
}

/** ページの配置。まだ保存していないページは空 */
export async function getPage(agent: Agent, did: Did, page: number): Promise<Placement[]> {
  try {
    const { data } = await agent.com.atproto.repo.getRecord({ repo: did, collection: NSID.binderPage, rkey: String(page) })
    return (data.value as unknown as BinderPage).placements ?? []
  } catch (e) {
    if ((e as { error?: unknown }).error === 'RecordNotFound') return []
    throw e
  }
}

export async function putPage(agent: Agent, did: Did, page: number, placements: Placement[]): Promise<void> {
  const record: BinderPage = { $type: NSID.binderPage, placements, updatedAt: new Date().toISOString() }
  await agent.com.atproto.repo.putRecord({ repo: did, collection: NSID.binderPage, rkey: String(page), record: { ...record } })
}
