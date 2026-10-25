// Bluesky のプロフィールを公開の AppView から読む（docs/sticker-detail.md ③）。Pikkles ではプロフィールを持たない
import type { Did } from '../lexicon-types.ts'

const PUBLIC_APPVIEW = 'https://public.api.bsky.app'

export interface Profile {
  did: Did
  handle: string
  displayName?: string
  avatar?: string
  description?: string
}

/** 同じ人がタイムラインに何度も並ぶので、1人1回だけ読む。失敗したら次に呼ばれたときに読み直す */
const cache = new Map<Did, Promise<Profile>>()

export function getProfile(did: Did): Promise<Profile> {
  let p = cache.get(did)
  if (!p) {
    p = fetchProfile(did)
    p.catch(() => cache.delete(did))
    cache.set(did, p)
  }
  return p
}

async function fetchProfile(did: Did): Promise<Profile> {
  const params = new URLSearchParams({ actor: did })
  const res = await fetch(`${PUBLIC_APPVIEW}/xrpc/app.bsky.actor.getProfile?${params}`)
  if (!res.ok) throw new Error(`プロフィールが読めません（${res.status}）`)
  return (await res.json()) as Profile
}
