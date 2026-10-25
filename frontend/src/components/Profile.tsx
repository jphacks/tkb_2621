// Bluesky のプロフィール（アイコンと表示名）を出す部品。読めない間・読めないときは今の Avatar と Handle を出す
import { useEffect, useState } from 'react'
import { getProfile, type Profile } from '../api/profile.ts'
import type { Did } from '../lexicon-types.ts'
import Avatar from './Avatar.tsx'
import Handle from './Handle.tsx'

function useProfile(did: Did): Profile | undefined {
  const [loaded, setLoaded] = useState<Profile>()

  useEffect(() => {
    let cancelled = false
    getProfile(did)
      .then((profile) => !cancelled && setLoaded(profile))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [did])

  return loaded?.did === did ? loaded : undefined
}

/** Bluesky のアイコン。設定していなければ頭文字の丸 */
export function ProfileAvatar({ did, size = 20 }: { did: Did; size?: number }) {
  const profile = useProfile(did)
  if (!profile?.avatar) return <Avatar did={did} size={size} />
  return <img className="avatar profile-avatar" src={profile.avatar} alt="" aria-hidden="true" width={size} height={size} />
}

/** Bluesky の表示名。設定していなければ @handle */
export function DisplayName({ did }: { did: Did }) {
  const profile = useProfile(did)
  const name = profile?.displayName?.trim()
  if (name) return <>{name}</>
  if (profile) return <>@{profile.handle}</>
  return <Handle did={did} />
}
