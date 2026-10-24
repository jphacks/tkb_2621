// ハンドルの頭文字を丸に入れたアイコン。色は DID から決め、同じ人はいつも同じ色にする
import { useEffect, useState } from 'react'
import { resolveDid } from '../api/sticker.ts'
import type { Did } from '../lexicon-types.ts'

const COLORS = ['#e95959', '#5995e9']

function colorOf(did: Did): string {
  let sum = 0
  for (const c of did) sum += c.charCodeAt(0)
  return COLORS[sum % COLORS.length]
}

export default function Avatar({ did, size = 20 }: { did: Did; size?: number }) {
  const [handle, setHandle] = useState<string>()

  useEffect(() => {
    let cancelled = false
    resolveDid(did)
      .then((info) => !cancelled && setHandle(info.handle))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [did])

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size / 2), background: colorOf(did) }}
    >
      {handle?.[0]?.toUpperCase() ?? ''}
    </span>
  )
}
