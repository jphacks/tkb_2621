// パソコンのカメラで撮る。input の capture 属性はスマホでしかカメラを開かないので、getUserMedia の映像からシャッターで1枚切り出す。
import { useEffect, useRef, useState } from 'react'

function cameraErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの使用が許可されていません。ブラウザの設定で許可してください'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません'
  if (name === 'NotReadableError') return 'カメラをほかのアプリが使っています'
  return `カメラを開けませんでした：${e instanceof Error ? e.message : String(e)}`
}

export default function WebcamCapture({ onCapture }: { onCapture: (file: File) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('このブラウザではカメラを使えません。「ファイルから選択」を使ってください')
      return
    }
    let stream: MediaStream | undefined
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch((e) => {
        if (!cancelled) setError(cameraErrorMessage(e))
      })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function shoot() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(new File([blob], 'camera.jpg', { type: 'image/jpeg' }))
      },
      'image/jpeg',
      0.92,
    )
  }

  return (
    <>
      <div className="capture-viewer">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <video ref={videoRef} className="capture-video" autoPlay playsInline muted onLoadedData={() => setReady(true)} />
        )}
        <p>
          モノを枠の中に。背景は自動で消えます
          <br />
          紙に描いたイラストもそのまま撮れます
        </p>
      </div>
      <button type="button" className="capture-shutter" onClick={shoot} disabled={!ready}>
        <img src="/images/shutter.svg" alt="" width={63} height={63} />
        <span className="visually-hidden">撮影する</span>
      </button>
    </>
  )
}
