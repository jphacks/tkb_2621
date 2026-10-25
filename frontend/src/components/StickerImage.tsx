// ステッカーの画像
import { useEffect, useState } from 'react'
import { stickerImageUrl } from '../api/sticker.ts'
import type { Did, Sticker } from '../lexicon-types.ts'

export default function StickerImage({ did, sticker, maxHeight }: { did: Did; sticker: Sticker; maxHeight: number }) {
  const [src, setSrc] = useState<string>()

  useEffect(() => {
    let cancelled = false
    stickerImageUrl(did, sticker)
      .then((url) => !cancelled && setSrc(url))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [did, sticker])

  return (
    <img
      src={src}
      alt={sticker.caption ?? 'ステッカー'}
      width={sticker.width}
      height={sticker.height}
      style={{ display: 'block', margin: '0 auto', maxWidth: '100%', maxHeight, width: 'auto', height: 'auto', objectFit: 'contain' }}
    />
  )
}
