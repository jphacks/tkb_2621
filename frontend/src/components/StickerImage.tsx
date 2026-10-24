// ステッカーの画像と、白フチと影が映える明るい単色の背景
import { useEffect, useState, type ReactNode } from 'react'
import { stickerImageUrl } from '../api/sticker.ts'
import type { Did, Sticker } from '../lexicon-types.ts'

/** 白フチが溶けないよう、白ではない明るい単色 */
const BACKDROP = '#f6f1e7'

/** .page の余白（16px）を打ち消して、画面いっぱいに背景を敷く */
export function StickerBackdrop({ children }: { children: ReactNode }) {
  return <div style={{ background: BACKDROP, margin: -16, padding: 16, minHeight: 'calc(100% + 32px)' }}>{children}</div>
}

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
