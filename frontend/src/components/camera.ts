// WebcamCapture と QrScanner で共通の、カメラが使えるかどうかとエラー文。
export function cameraErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの使用が許可されていません。ブラウザの設定で許可してください'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません'
  if (name === 'NotReadableError') return 'カメラをほかのアプリが使っています'
  return `カメラを開けませんでした：${e instanceof Error ? e.message : String(e)}`
}

/** 型の上では必ずあるが、http で開いたときや古いブラウザでは mediaDevices が無い */
export function canUseCamera(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function'
}
