// 撮った・選んだ画像を四角く切り出す。枠はドラッグで動かし、四隅のつまみで大きさを変える。
// 写真は JPEG、イラストは透過を残すため PNG で書き出す（どちらも canvas を通すのでメタデータは残らない）。
import { useEffect, useRef, useState, type PointerEvent } from 'react'

/** 画像に対する割合（0〜1）で持つ枠 */
type Rect = { left: number; top: number; right: number; bottom: number }
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'

const FULL: Rect = { left: 0, top: 0, right: 1, bottom: 1 }
const MIN = 0.05

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

function moveRect(start: Rect, handle: Handle, dx: number, dy: number): Rect {
  if (handle === 'move') {
    const w = start.right - start.left
    const h = start.bottom - start.top
    const left = clamp(start.left + dx, 0, 1 - w)
    const top = clamp(start.top + dy, 0, 1 - h)
    return { left, top, right: left + w, bottom: top + h }
  }
  const r = { ...start }
  if (handle.includes('w')) r.left = clamp(start.left + dx, 0, start.right - MIN)
  if (handle.includes('e')) r.right = clamp(start.right + dx, start.left + MIN, 1)
  if (handle.includes('n')) r.top = clamp(start.top + dy, 0, start.bottom - MIN)
  if (handle.includes('s')) r.bottom = clamp(start.bottom + dy, start.top + MIN, 1)
  return r
}

export default function ImageTrimmer({
  file,
  keepTransparency,
  onDone,
}: {
  file: File
  keepTransparency: boolean
  onDone: (file: File) => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ handle: Handle; x: number; y: number; start: Rect }>(undefined)
  const [url, setUrl] = useState<string>()
  const [rect, setRect] = useState<Rect>(FULL)
  const [loaded, setLoaded] = useState(false)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    const reader = new FileReader()
    reader.onload = () => setUrl(reader.result as string)
    reader.readAsDataURL(file)
    return () => reader.abort()
  }, [file])

  function onPointerDown(e: PointerEvent<HTMLElement>, handle: Handle) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { handle, x: e.clientX, y: e.clientY, start: rect }
  }

  function onPointerMove(e: PointerEvent<HTMLElement>) {
    const d = drag.current
    const stage = stageRef.current
    if (!d || !stage) return
    const box = stage.getBoundingClientRect()
    setRect(moveRect(d.start, d.handle, (e.clientX - d.x) / box.width, (e.clientY - d.y) / box.height))
  }

  function onPointerUp() {
    drag.current = undefined
  }

  function decide() {
    const img = imgRef.current
    if (!img || !img.naturalWidth) return
    const sx = Math.round(rect.left * img.naturalWidth)
    const sy = Math.round(rect.top * img.naturalHeight)
    const sw = Math.max(1, Math.round((rect.right - rect.left) * img.naturalWidth))
    const sh = Math.max(1, Math.round((rect.bottom - rect.top) * img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    canvas.getContext('2d')?.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    const type = keepTransparency ? 'image/png' : 'image/jpeg'
    setWorking(true)
    canvas.toBlob(
      (blob) => {
        setWorking(false)
        if (blob) onDone(new File([blob], keepTransparency ? 'trimmed.png' : 'trimmed.jpg', { type }))
      },
      type,
      0.92,
    )
  }

  const handleProps = (handle: Handle) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => onPointerDown(e, handle),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  })

  const boxStyle = {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${(rect.right - rect.left) * 100}%`,
    height: `${(rect.bottom - rect.top) * 100}%`,
  }

  return (
    <>
      <div className="trim-viewer">
        <div className="trim-stage" ref={stageRef}>
          {url && <img ref={imgRef} src={url} alt="切り出す画像" draggable={false} onLoad={() => setLoaded(true)} />}
          {loaded && (
            <>
              {/* 外側を暗くする影だけ画像の範囲で切り取り、枠とつまみは画像の外にはみ出せるようにする */}
              <div className="trim-shade">
                <div className="trim-hole" style={boxStyle} />
              </div>
              <div className="trim-box" style={boxStyle} {...handleProps('move')}>
                {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                  <span key={h} className={`trim-handle trim-handle-${h}`} {...handleProps(h)} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <p className="trim-hint">枠を動かして、ピクルスにしたいところを囲んでください</p>
      <div className="trim-actions">
        <button type="button" className="btn btn-block" onClick={() => setRect(FULL)} disabled={!loaded || working}>
          全体に戻す
        </button>
        <button type="button" className="btn btn-primary btn-block" onClick={decide} disabled={!loaded || working}>
          決定
        </button>
      </div>
    </>
  )
}
