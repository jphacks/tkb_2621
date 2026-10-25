// 共同フィールドの読み書き。field（作った人の PDS）、field.member と field.placement（各自の PDS）。
import { AtUri, type Agent } from '@atproto/api'
import { NSID, type Did, type Field, type FieldMember, type FieldPlacement, type Placement, type StrongRef } from '../lexicon-types.ts'
import { deleteFieldOnServer, getFieldMembers, leaveFieldOnServer, type FieldMembersResponse } from './backend.ts'
import { isRecordNotFound, listOwnRecords, listPublicRecords } from './binder.ts'
import { getSticker, resolveDid, stickerImageUrl } from './sticker.ts'

/** タイトルの上限（書記素の数） */
export const FIELD_TITLE_MAX = 50

export interface FieldView {
  ref: StrongRef
  creator: Did
  title: string
}

/** 共同フィールドが削除された（PDS が RecordNotFound を返した）。一時的に読めないだけのときは普通の Error */
export class FieldDeletedError extends Error {
  constructor() {
    super('このフィールドは削除されました')
    this.name = 'FieldDeletedError'
  }
}

/** 共同フィールドを作った人の PDS から読む（ログイン不要の公開 API） */
export async function getField(uri: string): Promise<FieldView> {
  const at = new AtUri(uri)
  if (at.collection !== NSID.field) throw new Error('共同フィールドの URI ではありません')
  const { pds } = await resolveDid(at.host)
  const params = new URLSearchParams({ repo: at.host, collection: at.collection, rkey: at.rkey })
  const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`)
  if (!res.ok) {
    if (await isRecordNotFound(res)) throw new FieldDeletedError()
    throw new Error(`共同フィールドが読めません（${res.status}）`)
  }
  const data = (await res.json()) as { uri: string; cid: string; value: Field }
  return { ref: { uri: data.uri, cid: data.cid }, creator: at.host, title: data.value.title }
}

export function fieldPath(field: Pick<StrongRef, 'uri'>): string {
  const at = new AtUri(field.uri)
  return `/fields/${encodeURIComponent(at.host)}/${encodeURIComponent(at.rkey)}`
}

/** 招待 QR の中身。開くと FieldJoin.tsx */
export function inviteUrl(field: StrongRef): string {
  return `${window.location.origin}/fields/join?${new URLSearchParams({ uri: field.uri, cid: field.cid })}`
}

// ---- 参加 ----

export type JoinedField = { uri: string; deleted: false; field: FieldView } | { uri: string; deleted: true; field?: FieldView }

/**
 * 参加中の共同フィールド（新しく参加した順）。
 * 削除された（field が無い・サーバーで閉じた）ものは deleted: true で返す。一時的に読めないものは出さない
 */
export async function listJoinedFields(agent: Agent, did: Did): Promise<JoinedField[]> {
  const members = await listOwnRecords<FieldMember>(agent, did, NSID.fieldMember)
  const uris = [
    ...new Set(
      [...members].sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)).map((m) => m.value.field.uri),
    ),
  ]
  const fields = await Promise.all(
    uris.map(async (uri): Promise<JoinedField | undefined> => {
      let field: FieldView
      try {
        field = await getField(uri)
      } catch (e) {
        return e instanceof FieldDeletedError ? { uri, deleted: true } : undefined
      }
      // サーバーが読めなければ、閉じていないものとして出す
      const closed = await getFieldMembers(agent, uri).then((r) => r.closed, () => false)
      return closed ? { uri, deleted: true, field } : { uri, deleted: false, field }
    }),
  )
  return fields.filter((f): f is JoinedField => f !== undefined)
}

export async function isMember(agent: Agent, did: Did, fieldUri: string): Promise<boolean> {
  const members = await listOwnRecords<FieldMember>(agent, did, NSID.fieldMember)
  return members.some((m) => m.value.field.uri === fieldUri)
}

/** 自分の PDS に field.member を書く。すでに参加していれば書かない */
export async function writeMember(agent: Agent, did: Did, field: StrongRef): Promise<void> {
  if (await isMember(agent, did, field.uri)) return
  const record: FieldMember = { $type: NSID.fieldMember, field, createdAt: new Date().toISOString() }
  await agent.com.atproto.repo.createRecord({ repo: did, collection: NSID.fieldMember, record: { ...record } })
}

/** field を作り、自分の field.member も書く */
export async function createField(agent: Agent, did: Did, title: string): Promise<StrongRef> {
  const record: Field = { $type: NSID.field, title: title.trim(), createdAt: new Date().toISOString() }
  const { data } = await agent.com.atproto.repo.createRecord({ repo: did, collection: NSID.field, record: { ...record } })
  const ref = { uri: data.uri, cid: data.cid }
  await writeMember(agent, did, ref)
  return ref
}

// ---- 貼り付け ----

export interface FieldItem {
  /** field.placement の URI */
  uri: string
  author: Did
  placement: Placement
  createdAt: string
  /** 読めない（削除された）ステッカーは undefined。描かない */
  imageUrl?: string
  width: number
  height: number
}

export function toPlacementOnly(p: FieldPlacement): Placement {
  return { sticker: p.sticker, x: p.x, y: p.y, scale: p.scale, rotation: p.rotation, z: p.z }
}

/** このフィールドを指し、author 自身のステッカーを貼った field.placement なら true。Jetstream で受け取った中身にも使う */
export function isOwnPlacement(author: Did, value: unknown, fieldUri: string): value is FieldPlacement {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<FieldPlacement>
  if (p.field?.uri !== fieldUri || typeof p.sticker?.uri !== 'string' || typeof p.sticker.cid !== 'string') return false
  if (![p.x, p.y, p.scale, p.rotation, p.z].every((n) => typeof n === 'number')) return false
  try {
    const at = new AtUri(p.sticker.uri)
    return at.host === author && at.collection === NSID.sticker
  } catch {
    return false
  }
}

interface StickerImage {
  imageUrl: string
  width: number
  height: number
}

/** 貼られたステッカーの画像と大きさ。読めない（削除された）ものは undefined */
function loadStickerImage(author: Did, ref: StrongRef): Promise<StickerImage | undefined> {
  return getSticker(ref)
    .then(async (s) => ({ imageUrl: await stickerImageUrl(author, s), width: s.width, height: s.height }))
    .catch(() => undefined)
}

function toFieldItem(uri: string, author: Did, value: FieldPlacement, s: StickerImage | undefined): FieldItem {
  return {
    uri,
    author,
    placement: toPlacementOnly(value),
    createdAt: value.createdAt,
    imageUrl: s?.imageUrl,
    width: s?.width ?? 1,
    height: s?.height ?? 1,
  }
}

/** field.placement 1件を画面に出す形にする（Jetstream で受け取ったとき） */
export async function loadFieldItem(uri: string, author: Did, value: FieldPlacement): Promise<FieldItem> {
  return toFieldItem(uri, author, value, await loadStickerImage(author, value.sticker))
}

/** メンバー全員の PDS から、このフィールドを指す field.placement を読む。自分のものでないステッカーを貼ったものは数えない */
export async function listFieldItems(fieldUri: string, members: Did[]): Promise<FieldItem[]> {
  const perMember = await Promise.all(
    members.map(async (member) => {
      try {
        const records = await listPublicRecords<FieldPlacement>(member, NSID.fieldPlacement)
        return records
          .filter(({ value }) => isOwnPlacement(member, value, fieldUri))
          .map((r) => ({ uri: r.uri, author: member, value: r.value }))
      } catch {
        // PDS が読めないメンバーの分は出さない
        return []
      }
    }),
  )
  const records = perMember.flat()

  // 同じステッカーは1回だけ読む
  const stickers = new Map<string, Promise<StickerImage | undefined>>()
  for (const { author, value } of records) {
    const key = `${value.sticker.uri}#${value.sticker.cid}`
    if (!stickers.has(key)) stickers.set(key, loadStickerImage(author, value.sticker))
  }

  return Promise.all(
    records.map(async ({ uri, author, value }) =>
      toFieldItem(uri, author, value, await stickers.get(`${value.sticker.uri}#${value.sticker.cid}`)),
    ),
  )
}

/** 自分の PDS に field.placement を作る。返り値はその URI と createdAt */
export async function createFieldPlacement(
  agent: Agent,
  did: Did,
  field: StrongRef,
  placement: Placement,
): Promise<{ uri: string; createdAt: string }> {
  if (new AtUri(placement.sticker.uri).host !== did) throw new Error('自分のステッカーだけを貼れます')
  const createdAt = new Date().toISOString()
  const record: FieldPlacement = { $type: NSID.fieldPlacement, field, ...placement, createdAt }
  const { data } = await agent.com.atproto.repo.createRecord({ repo: did, collection: NSID.fieldPlacement, record: { ...record } })
  return { uri: data.uri, createdAt }
}

/** 自分の field.placement を書き直す（動かした・一番上にした） */
export async function putFieldPlacement(
  agent: Agent,
  did: Did,
  uri: string,
  field: StrongRef,
  placement: Placement,
  createdAt: string,
): Promise<void> {
  const at = new AtUri(uri)
  if (at.host !== did || at.collection !== NSID.fieldPlacement) throw new Error('自分の貼り付けではありません')
  const record: FieldPlacement = { $type: NSID.fieldPlacement, field, ...placement, createdAt }
  await agent.com.atproto.repo.putRecord({ repo: did, collection: NSID.fieldPlacement, rkey: at.rkey, record: { ...record } })
}

/** 自分の field.placement を消す（はがす） */
export async function deleteFieldPlacement(agent: Agent, did: Did, uri: string): Promise<void> {
  const at = new AtUri(uri)
  if (at.host !== did || at.collection !== NSID.fieldPlacement) throw new Error('自分の貼り付けではありません')
  await agent.com.atproto.repo.deleteRecord({ repo: did, collection: NSID.fieldPlacement, rkey: at.rkey })
}

// ---- 抜ける・削除 ----

async function deleteOwnRecord(agent: Agent, did: Did, uri: string): Promise<void> {
  const at = new AtUri(uri)
  if (at.host !== did) throw new Error('自分の記録ではありません')
  await agent.com.atproto.repo.deleteRecord({ repo: did, collection: at.collection, rkey: at.rkey })
}

/** このフィールドを指す自分の field.placement、続けて field.member を消す（「一覧から外す」もこれだけ） */
export async function removeOwnFieldRecords(agent: Agent, did: Did, fieldUri: string): Promise<void> {
  const placements = await listOwnRecords<FieldPlacement>(agent, did, NSID.fieldPlacement)
  await Promise.all(placements.filter((r) => r.value.field?.uri === fieldUri).map((r) => deleteOwnRecord(agent, did, r.uri)))
  const members = await listOwnRecords<FieldMember>(agent, did, NSID.fieldMember)
  await Promise.all(members.filter((r) => r.value.field?.uri === fieldUri).map((r) => deleteOwnRecord(agent, did, r.uri)))
}

/** 作ったばかりで、サーバーに登録できなかった field を、自分の field.member ごと消す */
export async function discardCreatedField(agent: Agent, did: Did, field: StrongRef): Promise<void> {
  await removeOwnFieldRecords(agent, did, field.uri)
  await deleteOwnRecord(agent, did, field.uri)
}

/** 抜ける。残りが0人になり（closed）、自分が作った人なら field 本体も消す */
export async function leaveField(agent: Agent, did: Did, field: FieldView): Promise<FieldMembersResponse> {
  await removeOwnFieldRecords(agent, did, field.ref.uri)
  const res = await leaveFieldOnServer(agent, field.ref.uri)
  if (res.closed && field.creator === did) await deleteOwnRecord(agent, did, field.ref.uri)
  return res
}

/** 削除する（作った人だけ）。サーバーで閉じられなければ field 本体は消さずに止める */
export async function deleteField(agent: Agent, did: Did, field: FieldView): Promise<void> {
  if (field.creator !== did) throw new Error('作った人だけが削除できます')
  await removeOwnFieldRecords(agent, did, field.ref.uri)
  await deleteFieldOnServer(agent, field.ref.uri)
  await deleteOwnRecord(agent, did, field.ref.uri)
}

/** 自分が作った field のうち、サーバーで閉じているものを消す（作った人が先に抜けていた場合の後始末） */
export async function cleanupClosedOwnFields(agent: Agent, did: Did): Promise<void> {
  const fields = await listOwnRecords<Field>(agent, did, NSID.field)
  await Promise.all(
    fields.map(async (r) => {
      try {
        if ((await getFieldMembers(agent, r.uri)).closed) await deleteOwnRecord(agent, did, r.uri)
      } catch {
        // 読めなければ次に一覧を開いたときにやり直す
      }
    }),
  )
}
