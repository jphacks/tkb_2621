// 画面の中でカメラを映して QR を読む。iOS Safari には BarcodeDetector が無いので、映像を canvas に描いて jsQR で探す。
// カメラが使えないときは、端末のカメラアプリで読むよう案内する。
import jsQR from 'jsqr'
import { useEffect, useRef, useState } from 'react'
import { cameraErrorMessage, canUseCamera } from './camera.ts'

// 読む間隔と、読むときに縮める幅。大きいとスマホで重い
const SCAN_INTERVAL_MS = 200
const SCAN_MAX_WIDTH = 640

/** onResult が false を返すと読み続ける（関係ない QR を読んだとき） */
export default function QrScanner({ onResult, hint }: { onResult: (text: string) => boolean; hint: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const onResultRef = useRef(onResult)
  const [error, setError] = useState<string | undefined>(() =>
    canUseCamera() ? undefined : 'このブラウザでは画面の中にカメラを映せません',
  )

  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  useEffect(() => {
    if (!canUseCamera()) return
    let stream: MediaStream | undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    function scan() {
      if (cancelled) return
      const video = videoRef.current
      if (ctx && video && video.videoWidth) {
        const scale = Math.min(1, SCAN_MAX_WIDTH / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
        if (code?.data && onResultRef.current(code.data)) return
      }
      timer = setTimeout(scan, SCAN_INTERVAL_MS)
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
        scan()
      })
      .catch((e) => {
        if (!cancelled) setError(cameraErrorMessage(e))
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  if (error) {
    return (
      <div className="capture-viewer">
        <p role="alert">{error}</p>
        <p>端末のカメラアプリで QR を読み取ってください</p>
      </div>
    )
  }

  return (
    <div className="capture-viewer capture-viewer-live">
      <video ref={videoRef} className="capture-video" autoPlay playsInline muted />
      <div className="capture-frame" aria-hidden="true" />
      <p>{hint}</p>
    </div>
  )
}
