// シール帳の1ページを描くキャンバス。ドラッグで移動、取っ手か2本指で拡大縮小・回転、触ったものを一番上に。
import Konva from 'konva'
import { useEffect, useRef, useState } from 'react'
import { Image as KonvaImage, Layer, Rect, Stage, Transformer } from 'react-konva'
import { BASE_SIZE_RATIO, PAGE_ASPECT, fromPlacement, toPlacement } from '../api/binder.ts'
import type { Placement } from '../lexicon-types.ts'

// 1本指でドラッグ中にもう1本の指が触れたとき、2本指の操作として拾えるようにする
Konva.hitOnDragEnabled = true

export interface CanvasItem {
  /** 画面の中だけで使う識別子（同じステッカーを2枚貼っても区別する） */
  id: string
  placement: Placement
  /** 読めない（削除された）ステッカーは undefined。描かない */
  imageUrl?: string
  width: number
  height: number
  /** true なら動かせない（共同フィールドの他人のステッカー）。タップすると onTapLocked */
  locked?: boolean
}

function useHtmlImage(url: string | undefined): HTMLImageElement | undefined {
  const [image, setImage] = useState<HTMLImageElement>()
  useEffect(() => {
    if (!url) return
    let cancelled = false
    const img = new window.Image()
    img.onload = () => !cancelled && setImage(img)
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])
  return url ? image : undefined
}

function StickerNode(props: {
  item: CanvasItem
  pageWidth: number
  /** 描いた Konva のノードを親に知らせる（Transformer と2本指の操作で使う） */
  register: (node: Konva.Image | null) => void
  onSelect: () => void
  onChange: (node: Konva.Image) => void
  onTapLocked?: () => void
}) {
  const { item, pageWidth, register } = props
  const image = useHtmlImage(item.imageUrl)
  if (!image) return null
  const view = fromPlacement(item.placement, pageWidth)
  // 等倍で長いほうの辺がページ幅の BASE_SIZE_RATIO
  const k = (pageWidth * BASE_SIZE_RATIO) / Math.max(item.width, item.height)
  const w = item.width * k
  const h = item.height * k
  return (
    <KonvaImage
      ref={register}
      image={image}
      x={view.x}
      y={view.y}
      width={w}
      height={h}
      offsetX={w / 2}
      offsetY={h / 2}
      scaleX={view.scale}
      scaleY={view.scale}
      rotation={view.rotation}
      draggable={!item.locked}
      onMouseDown={item.locked ? undefined : props.onSelect}
      // 2本指目で別のステッカーに触れても、選んでいるものは変えない
      onTouchStart={item.locked ? undefined : (e) => e.evt.touches.length === 1 && props.onSelect()}
      onClick={item.locked ? props.onTapLocked : undefined}
      onTap={item.locked ? props.onTapLocked : undefined}
      onDragEnd={(e) => props.onChange(e.target as Konva.Image)}
      onTransformEnd={(e) => props.onChange(e.target as Konva.Image)}
    />
  )
}

interface Pinch {
  dist: number
  angle: number
  scale: number
  rotation: number
}

/** ぷかぷかの揺れ幅（画面上の px） */
const FLOAT_PX = 4
const FLOAT_SWAY_PX = 1.5

/** 1枚ずつ揺れの速さと始まりをずらすための値。同じ id ならいつも同じ */
function floatSeed(id: string): number {
  let sum = 0
  for (const c of id) sum = (sum * 31 + c.charCodeAt(0)) % 997
  return sum
}

/** ビンの泡。位置は Figma の配置をビンの幅・高さに対する割合にしたもの */
const BUBBLES = [
  { src: '/images/bubble-1.svg', left: '89%', top: '3%' },
  { src: '/images/bubble-2.svg', left: '94%', top: '11%' },
  { src: '/images/bubble-3.svg', left: '5%', top: '67%' },
  { src: '/images/bubble-4.svg', left: '11%', top: '74%' },
  { src: '/images/bubble-5.svg', left: '5%', top: '86%' },
]

function touchGeometry(touches: TouchList) {
  const [a, b] = [touches[0], touches[1]]
  const dx = b.clientX - a.clientX
  const dy = b.clientY - a.clientY
  return { dist: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI }
}

export default function BinderCanvas(props: {
  items: CanvasItem[]
  /** 選んでいるもの（親が持つ。「はがす」を出すため） */
  selectedId: string | undefined
  /** ステッカーをタップしたとき、または何もないところをタップしたとき（undefined） */
  onSelect: (id: string | undefined) => void
  /** 触ったものを一番上にする */
  onFront: (id: string) => void
  /** 動かし終わったときの配置（Lexicon の整数の単位） */
  onChange: (id: string, placement: Placement) => void
  /** locked のステッカーをタップしたとき */
  onTapLocked?: (id: string) => void
  /** true ならビン（シール帳）の見た目にして、ステッカーをぷかぷか揺らす */
  jar?: boolean
}) {
  const { items, selectedId, onSelect, onFront, onChange, onTapLocked, jar } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [pageWidth, setPageWidth] = useState(0)
  const nodes = useRef(new Map<string, Konva.Image>())
  const transformerRef = useRef<Konva.Transformer>(null)
  const pinch = useRef<Pinch | undefined>(undefined)
  const selectedRef = useRef(selectedId)

  useEffect(() => {
    selectedRef.current = selectedId
  })

  // ビンでは、ステッカーを液体に浮いているように揺らす。中心（offset）だけを動かすので、保存する x・y・拡大・回転には入らない。
  // 選んでいるもの・ドラッグ中のもの・2本指で操作中のものは揺らさない。
  // react-konva は Stage の中身を後から描くので、Layer はこの effect の時点ではまだ無い。毎フレーム、ステッカーから Layer を引いて描き直す
  useEffect(() => {
    const map = nodes.current
    if (!jar || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = new Konva.Animation((frame) => {
      if (!frame) return
      const t = frame.time / 1000
      let layer: Konva.Layer | null = null
      for (const [id, node] of map) {
        const still = id === selectedRef.current || node.isDragging()
        const seed = floatSeed(id)
        const speed = 1.1 + (seed % 5) * 0.15
        const scale = node.scaleX() || 1
        const dy = still ? 0 : (Math.sin(t * speed + seed) * FLOAT_PX) / scale
        const dx = still ? 0 : (Math.sin(t * speed * 0.6 + seed) * FLOAT_SWAY_PX) / scale
        node.offset({ x: node.width() / 2 - dx, y: node.height() / 2 - dy })
        layer ??= node.getLayer()
      }
      layer?.batchDraw()
    })
    animation.start()
    return () => {
      animation.stop()
      for (const node of map.values()) node.offset({ x: node.width() / 2, y: node.height() / 2 })
    }
  }, [jar])

  // 画面幅に合わせる
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setPageWidth(Math.floor(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const selected = items.find((item) => item.id === selectedId)
  useEffect(() => {
    const node = selectedId ? nodes.current.get(selectedId) : undefined
    transformerRef.current?.nodes(node ? [node] : [])
  })

  function commit(id: string, node: Konva.Image) {
    const item = items.find((i) => i.id === id)
    if (!item || pageWidth === 0) return
    const placement = toPlacement(
      item.placement.sticker,
      { x: node.x(), y: node.y(), scale: node.scaleX(), rotation: node.rotation() },
      pageWidth,
      item.placement.z,
    )
    // 範囲に丸めた値を画面にも戻す（同じ値なら props が変わらず描き直されないため）
    const view = fromPlacement(placement, pageWidth)
    node.position({ x: view.x, y: view.y })
    node.scale({ x: view.scale, y: view.scale })
    node.rotation(view.rotation)
    onChange(id, placement)
  }

  function select(id: string) {
    onSelect(id)
    onFront(id)
  }

  function onTouchMove(e: Konva.KonvaEventObject<TouchEvent>) {
    const touches = e.evt.touches
    const node = selectedId ? nodes.current.get(selectedId) : undefined
    if (touches.length !== 2 || !node) return
    e.evt.preventDefault()
    const { dist, angle } = touchGeometry(touches)
    if (!pinch.current) {
      node.stopDrag()
      pinch.current = { dist, angle, scale: node.scaleX(), rotation: node.rotation() }
      return
    }
    const start = pinch.current
    const scale = start.scale * (dist / start.dist)
    node.scale({ x: scale, y: scale })
    node.rotation(start.rotation + angle - start.angle)
    node.getLayer()?.batchDraw()
  }

  function onTouchEnd(e: Konva.KonvaEventObject<TouchEvent>) {
    if (!pinch.current || e.evt.touches.length >= 2) return
    pinch.current = undefined
    const node = selectedId ? nodes.current.get(selectedId) : undefined
    if (selectedId && node) commit(selectedId, node)
  }

  const pageHeight = Math.round(pageWidth * PAGE_ASPECT)
  const sorted = [...items].sort((a, b) => a.placement.z - b.placement.z)

  return (
    <div ref={containerRef} className={jar ? 'binder-jar' : undefined} style={jar ? undefined : { width: '100%' }}>
      {jar && (
        <div className="binder-bubbles" aria-hidden="true">
          {BUBBLES.map((b) => (
            <img key={b.src} src={b.src} alt="" style={{ left: b.left, top: b.top }} />
          ))}
        </div>
      )}
      {pageWidth > 0 && (
        <Stage
          width={pageWidth}
          height={pageHeight}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onMouseDown={(e) => e.target === e.target.getStage() && onSelect(undefined)}
          onTouchStart={(e) => e.evt.touches.length === 1 && e.target === e.target.getStage() && onSelect(undefined)}
        >
          <Layer>
            {!jar && <Rect width={pageWidth} height={pageHeight} fill="#fffdf6" stroke="#ccc" listening={false} />}
            {sorted.map((item) => (
              <StickerNode
                key={item.id}
                item={item}
                pageWidth={pageWidth}
                register={(node) => {
                  if (node) nodes.current.set(item.id, node)
                  else nodes.current.delete(item.id)
                }}
                onSelect={() => select(item.id)}
                onChange={(node) => commit(item.id, node)}
                onTapLocked={() => {
                  // 他人のものをタップしたら、選んでいた自分のものは外す
                  onSelect(undefined)
                  onTapLocked?.(item.id)
                }}
              />
            ))}
            {selected && (
              <Transformer
                ref={transformerRef}
                keepRatio
                flipEnabled={false}
                enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 20 || Math.abs(newBox.height) < 20 ? oldBox : newBox)}
              />
            )}
          </Layer>
        </Stage>
      )}
    </div>
  )
}
