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

export async function getProfile(did: Did): Promise<Profile> {
  const params = new URLSearchParams({ actor: did })
  const res = await fetch(`${PUBLIC_APPVIEW}/xrpc/app.bsky.actor.getProfile?${params}`)
  if (!res.ok) throw new Error(`プロフィールが読めません（${res.status}）`)
  return (await res.json()) as Profile
}
