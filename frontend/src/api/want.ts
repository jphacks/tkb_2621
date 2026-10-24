// 「ほしい」（spec 3章 #12）。付け外しは自分の PDS（ログイン中の agent）、相手の分は相手の PDS を公開 API で読む
import { AtUri, type Agent } from '@atproto/api'
import { NSID, type Did, type StrongRef, type Want } from '../lexicon-types.ts'
import { resolveDid } from './sticker.ts'

/** ステッカーの URI → 自分の want レコードの URI */
type WantMap = Map<string, string>

// 画面のあちこちに WantButton が並ぶので、自分の want はページ読み込みごとに1回だけ読む
const myWantsCache = new Map<Did, Promise<WantMap>>()

async function fetchMyWants(agent: Agent, did: Did): Promise<WantMap> {
  const wants: WantMap = new Map()
  let cursor: string | undefined
  do {
    const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: NSID.want, limit: 100, cursor })
    for (const r of data.records) {
      const subject = (r.value as unknown as Want).subject
      if (subject?.uri) wants.set(subject.uri, r.uri)
    }
    cursor = data.records.length > 0 ? data.cursor : undefined
  } while (cursor)
  return wants
}

export function getMyWants(agent: Agent, did: Did): Promise<WantMap> {
  let wants = myWantsCache.get(did)
  if (!wants) {
    wants = fetchMyWants(agent, did)
    wants.catch(() => myWantsCache.delete(did))
    myWantsCache.set(did, wants)
  }
  return wants
}

export async function addWant(agent: Agent, did: Did, subject: StrongRef): Promise<void> {
  const record: Want = { $type: NSID.want, subject, createdAt: new Date().toISOString() }
  const { data } = await agent.com.atproto.repo.createRecord({ repo: did, collection: NSID.want, record: { ...record } })
  ;(await getMyWants(agent, did)).set(subject.uri, data.uri)
}

export async function removeWant(agent: Agent, did: Did, subjectUri: string): Promise<void> {
  const wants = await getMyWants(agent, did)
  const uri = wants.get(subjectUri)
  if (!uri) return
  await agent.com.atproto.repo.deleteRecord({ repo: did, collection: NSID.want, rkey: new AtUri(uri).rkey })
  wants.delete(subjectUri)
}

/** did の人が「ほしい」を付けたステッカーの URI。相手の PDS を listRecords で読む */
export async function listWantedBy(did: Did): Promise<Set<string>> {
  const { pds } = await resolveDid(did)
  const wanted = new Set<string>()
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ repo: did, collection: NSID.want, limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`)
    if (!res.ok) throw new Error(`「ほしい」が読めません（${res.status}）`)
    const data = (await res.json()) as { records: { value: Want }[]; cursor?: string }
    for (const r of data.records) if (r.value.subject?.uri) wanted.add(r.value.subject.uri)
    cursor = data.records.length > 0 ? data.cursor : undefined
  } while (cursor)
  return wanted
}
