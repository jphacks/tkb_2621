// 共同フィールドの読み書き。field（作った人の PDS）、field.member と field.placement（各自の PDS）。
import { AtUri, type Agent } from '@atproto/api'
import { NSID, type Did, type Field, type FieldMember, type FieldPlacement, type Placement, type StrongRef } from '../lexicon-types.ts'
import { listOwnRecords, listPublicRecords } from './binder.ts'
import { getSticker, resolveDid, stickerImageUrl } from './sticker.ts'

/** タイトルの上限（書記素の数） */
export const FIELD_TITLE_MAX = 50

export interface FieldView {
  ref: StrongRef
  creator: Did
  title: string
}

/** 共同フィールドを作った人の PDS から読む（ログイン不要の公開 API） */
export async function getField(uri: string): Promise<FieldView> {
  const at = new AtUri(uri)
  if (at.collection !== NSID.field) throw new Error('共同フィールドの URI ではありません')
  const { pds } = await resolveDid(at.host)
  const params = new URLSearchParams({ repo: at.host, collection: at.collection, rkey: at.rkey })
  const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`)
  if (!res.ok) throw new Error(`共同フィールドが読めません（${res.status}）`)
  const data = (await res.json()) as { uri: string; cid: string; value: Field }
  return { ref: { uri: data.uri, cid: data.cid }, creator: at.host, title: data.value.title }
}

export function fieldPath(field: StrongRef): string {
  const at = new AtUri(field.uri)
  return `/fields/${encodeURIComponent(at.host)}/${encodeURIComponent(at.rkey)}`
}

/** 招待 QR の中身。開くと FieldJoin.tsx */
export function inviteUrl(field: StrongRef): string {
  return `${window.location.origin}/fields/join?${new URLSearchParams({ uri: field.uri, cid: field.cid })}`
}

// ---- 参加 ----

/** 参加中の共同フィールド（新しく参加した順）。読めない（削除された）ものは出さない */
export async function listJoinedFields(agent: Agent, did: Did): Promise<FieldView[]> {
  const members = await listOwnRecords<FieldMember>(agent, did, NSID.fieldMember)
  const uris = [
    ...new Set(
      [...members].sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)).map((m) => m.value.field.uri),
    ),
  ]
  const fields = await Promise.all(uris.map((uri) => getField(uri).catch(() => undefined)))
  return fields.filter((f): f is FieldView => f !== undefined)
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

function toPlacementOnly(p: FieldPlacement): Placement {
  return { sticker: p.sticker, x: p.x, y: p.y, scale: p.scale, rotation: p.rotation, z: p.z }
}

/** メンバー全員の PDS から、このフィールドを指す field.placement を読む。自分のものでないステッカーを貼ったものは数えない */
export async function listFieldItems(fieldUri: string, members: Did[]): Promise<FieldItem[]> {
  const perMember = await Promise.all(
    members.map(async (member) => {
      try {
        const records = await listPublicRecords<FieldPlacement>(member, NSID.fieldPlacement)
        return records
          .filter(({ value }) => value.field?.uri === fieldUri)
          .filter(({ value }) => {
            try {
              const at = new AtUri(value.sticker.uri)
              return at.host === member && at.collection === NSID.sticker
            } catch {
              return false
            }
          })
          .map((r) => ({ uri: r.uri, author: member, value: r.value }))
      } catch {
        // PDS が読めないメンバーの分は出さない
        return []
      }
    }),
  )
  const records = perMember.flat()

  // 同じステッカーは1回だけ読む
  const stickers = new Map<string, Promise<{ imageUrl: string; width: number; height: number } | undefined>>()
  for (const { author, value } of records) {
    const key = `${value.sticker.uri}#${value.sticker.cid}`
    if (stickers.has(key)) continue
    stickers.set(
      key,
      getSticker(value.sticker)
        .then(async (s) => ({ imageUrl: await stickerImageUrl(author, s), width: s.width, height: s.height }))
        .catch(() => undefined),
    )
  }

  return Promise.all(
    records.map(async ({ uri, author, value }) => {
      const s = await stickers.get(`${value.sticker.uri}#${value.sticker.cid}`)
      return {
        uri,
        author,
        placement: toPlacementOnly(value),
        createdAt: value.createdAt,
        imageUrl: s?.imageUrl,
        width: s?.width ?? 1,
        height: s?.height ?? 1,
      }
    }),
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
