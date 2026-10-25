// ビンの1ページを PNG にする（spec 3章 #15）。画像は端末の中で作り、サーバーには送らない。
// 描くのは漬け液の背景・泡・貼ったピクルス・右下のロゴだけ。交換相手のハンドルや場面は入れない（相手の同意なく外の SNS に出さないため）。
import { BASE_SIZE_RATIO, PAGE_ASPECT, fromPlacement, type Brine } from '../api/binder.ts'
import type { CanvasItem } from './BinderCanvas.tsx'
import { BUBBLES } from './jarBubbles.ts'

const WIDTH = 1080
const HEIGHT = Math.round(WIDTH * PAGE_ASPECT)
/** 泡の大きさは、画面の幅がこのくらいのビンに出ているときに合わせる（泡は画面の px で大きさが決まっているため） */
const BUBBLE_REFERENCE_WIDTH = 360
const SITE = 'pikkles.kosora623.com'
export const SHARE_URL = `https://${SITE}`
export const SHARE_TEXT = 'ビンに漬けたピクルス #Pikkles'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 他の PDS の画像。<img> で描くと canvas が汚れて PNG にできないので、blob にしてから描く */
async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`画像を読めませんでした（${res.status}）`)
  return createImageBitmap(await res.blob())
}

/** 同じオリジンの SVG（泡）。createImageBitmap は SVG を読めないブラウザがあるので <img> で読む */
async function loadSvg(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  await img.decode()
  return img
}

export async function renderBinderPage(items: CanvasItem[], brine: Brine): Promise<Blob> {
  const drawn = [...items].filter((item) => item.imageUrl).sort((a, b) => a.placement.z - b.placement.z)
  const fontDisplay = cssVar('--font-display')
  const fontBase = cssVar('--font-base')
  const [loaded, bubbles, logo] = await Promise.all([
    // 読めなかったピクルス（相手の PDS が落ちている など）は描かずに飛ばす。全部読めなかったときだけエラーにする
    Promise.allSettled(drawn.map((item) => loadBitmap(item.imageUrl as string))),
    Promise.all(BUBBLES.map((b) => loadSvg(b.src))),
    loadBitmap('/images/logo.png'),
    document.fonts.load(`48px ${fontDisplay}`, 'Pikkles'),
    document.fonts.load(`28px ${fontBase}`, SITE),
  ])
  const stickers = loaded.map((r) => (r.status === 'fulfilled' ? r.value : undefined))
  const failed = loaded.find((r) => r.status === 'rejected')
  if (failed && stickers.every((s) => s === undefined)) {
    logo.close()
    throw failed.reason
  }

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas を使えませんでした')

  // 漬け液。CSS（.binder-jar）と同じく、画面の地の色の上に半透明の漬け液のグラデーションを重ねる
  ctx.fillStyle = cssVar('--color-bg')
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  const jar = ctx.createLinearGradient(0, 0, 0, HEIGHT)
  jar.addColorStop(0, cssVar(`--brine-${brine}-top`))
  jar.addColorStop(1, cssVar(`--brine-${brine}-bottom`))
  ctx.fillStyle = jar
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  const bubbleScale = WIDTH / BUBBLE_REFERENCE_WIDTH
  BUBBLES.forEach((b, i) => {
    const img = bubbles[i]
    ctx.drawImage(img, (parseFloat(b.left) / 100) * WIDTH, (parseFloat(b.top) / 100) * HEIGHT, img.width * bubbleScale, img.height * bubbleScale)
  })

  // 保存されている配置どおりに描く（BinderCanvas の StickerNode と同じ計算）。揺れは入れない
  drawn.forEach((item, i) => {
    const bitmap = stickers[i]
    if (!bitmap) return
    const view = fromPlacement(item.placement, WIDTH)
    const k = (WIDTH * BASE_SIZE_RATIO) / Math.max(item.width, item.height)
    const w = item.width * k
    const h = item.height * k
    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.rotate((view.rotation * Math.PI) / 180)
    ctx.scale(view.scale, view.scale)
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h)
    ctx.restore()
  })

  // 右下に小さくロゴとサイトのアドレス
  const margin = 32
  const logoSize = 64
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = cssVar('--color-text-muted')
  ctx.font = `${cssVar('--font-weight-medium')} 24px ${fontBase}`
  ctx.fillText(SITE, WIDTH - margin, HEIGHT - margin)
  ctx.fillStyle = cssVar('--color-brand')
  ctx.font = `44px ${fontDisplay}`
  const titleBaseline = HEIGHT - margin - 34
  ctx.fillText('Pikkles', WIDTH - margin, titleBaseline)
  const titleWidth = ctx.measureText('Pikkles').width
  ctx.drawImage(logo, WIDTH - margin - titleWidth - 8 - logoSize, titleBaseline - logoSize + 10, logoSize, logoSize)

  for (const bitmap of [...stickers, logo]) bitmap?.close()

  return new Promise((resolve, reject) => {
    // canvas の PNG には EXIF などのメタデータは入らない
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG にできませんでした'))), 'image/png')
  })
}
