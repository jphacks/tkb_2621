// 画面の中でカメラを映して撮る。input の capture 属性だとスマホは端末のカメラアプリに移り、パソコンはカメラが開かないので、
// getUserMedia の映像をビューアの中に出し、シャッターで1枚切り出す。カメラが使えないときだけ input に逃がす。
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { cameraErrorMessage, canUseCamera } from './camera.ts'

export default function WebcamCapture({ onCapture }: { onCapture: (file: File) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | undefined>(() =>
    canUseCamera() ? undefined : 'このブラウザでは画面の中にカメラを映せません',
  )

  useEffect(() => {
    if (!canUseCamera()) return
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

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onCapture(file)
  }

  if (error) {
    return (
      <>
        <div className="capture-viewer">
          <p role="alert">{error}</p>
          <p>下のボタンで端末のカメラを開いて撮れます</p>
        </div>
        <label className="capture-shutter">
          <input type="file" className="visually-hidden" accept="image/*" capture="environment" onChange={onFile} />
          <img src="/images/shutter.svg" alt="" width={63} height={63} />
          <span className="visually-hidden">撮影する</span>
        </label>
      </>
    )
  }

  return (
    <>
      <div className="capture-viewer capture-viewer-live">
        <video ref={videoRef} className="capture-video" autoPlay playsInline muted onLoadedData={() => setReady(true)} />
        <div className="capture-frame" aria-hidden="true" />
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
