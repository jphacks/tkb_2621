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
      alt={sticker.caption ?? 'ピクルス'}
      width={sticker.width}
      height={sticker.height}
      // 画面の外のピクルスは、近づくまで読まない（PDS から原寸の PNG を読むので重い）
      loading="lazy"
      decoding="async"
      style={{ display: 'block', margin: '0 auto', maxWidth: '100%', maxHeight, width: 'auto', height: 'auto', objectFit: 'contain' }}
    />
  )
}
