// ステッカーを読む・画像の URL を作る（ログイン不要の公開 API）と、自分のステッカーを保存・削除する（ログイン中の agent）
import { AtUri, type Agent } from '@atproto/api'
import { NSID, type BlobRef, type Did, type StrongRef, type Sticker } from '../lexicon-types.ts'

export interface DidInfo {
  pds: string
  handle?: string
}

interface DidDocument {
  alsoKnownAs?: string[]
  service?: { id: string; type: string; serviceEndpoint: string }[]
}

const didCache = new Map<Did, Promise<DidInfo>>()

async function fetchDidInfo(did: Did): Promise<DidInfo> {
  let url: string
  if (did.startsWith('did:plc:')) url = `https://plc.directory/${did}`
  else if (did.startsWith('did:web:')) url = `https://${did.slice('did:web:'.length)}/.well-known/did.json`
  else throw new Error(`対応していない DID です：${did}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`DID 文書が読めません（${res.status}）`)
  const doc = (await res.json()) as DidDocument
  const pds = doc.service?.find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)?.serviceEndpoint
  if (!pds) throw new Error('PDS が見つかりません')
  const handle = doc.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice('at://'.length)
  return { pds: pds.replace(/\/$/, ''), handle }
}

/** DID から PDS とハンドルを引く */
export function resolveDid(did: Did): Promise<DidInfo> {
  let info = didCache.get(did)
  if (!info) {
    info = fetchDidInfo(did)
    info.catch(() => didCache.delete(did))
    didCache.set(did, info)
  }
  return info
}

/** blob の CID。@atproto/api が返す BlobRef（ref が CID）と JSON（ref が {$link}）のどちらでも取れる */
function blobCid(image: BlobRef): string {
  const ref = image.ref as unknown
  if (ref && typeof ref === 'object' && '$link' in ref) return String((ref as { $link: unknown }).$link)
  return String(ref)
}

export async function stickerImageUrl(did: Did, sticker: Sticker): Promise<string> {
  const { pds } = await resolveDid(did)
  const params = new URLSearchParams({ did, cid: blobCid(sticker.image) })
  return `${pds}/xrpc/com.atproto.sync.getBlob?${params}`
}

/** strongRef の先のステッカーを、持ち主の PDS から読む */
export async function getSticker(ref: StrongRef): Promise<Sticker> {
  const uri = new AtUri(ref.uri)
  const { pds } = await resolveDid(uri.host)
  const params = new URLSearchParams({ repo: uri.host, collection: uri.collection, rkey: uri.rkey, cid: ref.cid })
  const res = await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${params}`)
  if (!res.ok) throw new Error(`ステッカーが読めません（${res.status}）`)
  const data = (await res.json()) as { value: Sticker }
  return data.value
}

/** 一言の上限（書記素の数） */
export const CAPTION_MAX = 100

export function countGraphemes(text: string): number {
  return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)].length
}

export interface NewSticker {
  /** /cutout が返した透過PNG */
  png: Blob
  width: number
  height: number
  source: Sticker['source']
  caption?: string
}

/** 自分の PDS に uploadBlob → createRecord で保存する。createdAt は保存した時刻（EXIF は読まない） */
export async function createSticker(agent: Agent, did: Did, sticker: NewSticker): Promise<StrongRef> {
  const { data: uploaded } = await agent.uploadBlob(sticker.png, { encoding: 'image/png' })
  const caption = sticker.caption?.trim()
  const record: Sticker = {
    $type: NSID.sticker,
    image: uploaded.blob.toJSON() as BlobRef,
    width: sticker.width,
    height: sticker.height,
    source: sticker.source,
    ...(caption ? { caption } : {}),
    createdAt: new Date().toISOString(),
  }
  const { data } = await agent.com.atproto.repo.createRecord({ repo: did, collection: NSID.sticker, record: { ...record } })
  return { uri: data.uri, cid: data.cid }
}

/** 自分のステッカーを消す。他人のものは消せない */
export async function deleteSticker(agent: Agent, did: Did, uri: string): Promise<void> {
  const at = new AtUri(uri)
  if (at.host !== did || at.collection !== NSID.sticker) throw new Error('自分のステッカーではありません')
  await agent.com.atproto.repo.deleteRecord({ repo: did, collection: NSID.sticker, rkey: at.rkey })
}
