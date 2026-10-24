// Blueskyでもフォローする（spec 3章 #13）。フォロー済みかは公開の AppView に聞き、フォローは自分の PDS に書く
import type { Agent } from '@atproto/api'
import type { Did } from '../lexicon-types.ts'

const FOLLOW_COLLECTION = 'app.bsky.graph.follow'
const PUBLIC_APPVIEW = 'https://public.api.bsky.app'

/** actor が subject をフォローしているか */
export async function isFollowing(actor: Did, subject: Did): Promise<boolean> {
  const params = new URLSearchParams({ actor, others: subject })
  const res = await fetch(`${PUBLIC_APPVIEW}/xrpc/app.bsky.graph.getRelationships?${params}`)
  if (!res.ok) throw new Error(`フォローの状態が読めません（${res.status}）`)
  const data = (await res.json()) as { relationships: { did?: string; following?: string }[] }
  return Boolean(data.relationships.find((r) => r.did === subject)?.following)
}

export async function follow(agent: Agent, did: Did, subject: Did): Promise<void> {
  await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: FOLLOW_COLLECTION,
    record: { $type: FOLLOW_COLLECTION, subject, createdAt: new Date().toISOString() },
  })
}
