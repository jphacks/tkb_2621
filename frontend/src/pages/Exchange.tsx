// S5 対面交換：始める側（A）。場面を入れてセッションを作り、参加用の QR を出す。
import QRCode from 'qrcode'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { BackendError, createSession, refreshQr } from '../api/backend.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import BackendWaking from '../components/BackendWaking.tsx'
import ExchangeRoom from '../components/ExchangeRoom.tsx'

const OCCASION_MAX = 50
// 参加URLは60秒で失効するので、50秒ごとに QR を作り直す
const QR_REDRAW_MS = 50_000
// 相手の参加は /qr が 409 を返すことで分かるので、短い間隔で確かめる
const JOIN_CHECK_MS = 5_000

interface Started {
  sessionId: string
  joinUrl: string
  occasion: string | null
}

function QrCode({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string>()
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(url, { width: 640, margin: 2 })
      .then((d) => !cancelled && setDataUrl(d))
      .catch(() => !cancelled && setDataUrl(undefined))
    return () => {
      cancelled = true
    }
  }, [url])
  if (!dataUrl) return <p>QR を作っています…</p>
  return <img src={dataUrl} alt="参加用の QR コード" style={{ width: '100%', maxWidth: 360, imageRendering: 'pixelated' }} />
}

export default function Exchange() {
  const auth = useAuth()
  const [occasion, setOccasion] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string>()
  const [started, setStarted] = useState<Started>()
  const [joined, setJoined] = useState(false)
  const agent = auth.status === 'signedIn' ? auth.agent : undefined

  // 相手が参加するまで、/qr で参加を確かめつつ QR を作り直す
  useEffect(() => {
    if (!agent || !started || joined) return
    let stopped = false
    let shownAt = Date.now()
    const timer = setInterval(async () => {
      try {
        const res = await refreshQr(agent, started.sessionId)
        if (stopped) return
        if (Date.now() - shownAt >= QR_REDRAW_MS) {
          shownAt = Date.now()
          setStarted((s) => (s && s.sessionId === res.sessionId ? { ...s, joinUrl: res.joinUrl } : s))
        }
      } catch (e) {
        if (stopped || !(e instanceof BackendError)) return
        if (e.status === 409) setJoined(true)
        else if (e.status === 404) {
          stopped = true
          clearInterval(timer)
          setError('セッションが終わりました。もう一度はじめてください')
        }
      }
    }, JOIN_CHECK_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [agent, started, joined])

  const onJoined = useCallback(() => setJoined(true), [])

  if (auth.status === 'loading') return <p>読み込み中…</p>
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!agent) return
    setStarting(true)
    setError(undefined)
    try {
      const value = occasion.trim() || null
      const res = await createSession(agent, value)
      setJoined(false)
      setStarted({ ...res, occasion: value })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  if (started) {
    return (
      <>
        <BackendWaking />
        <ExchangeRoom
          key={started.sessionId}
          agent={auth.agent}
          did={auth.did}
          sessionId={started.sessionId}
          occasion={started.occasion}
          partnerJoined={joined}
          onJoined={onJoined}
          waiting={
            <>
              <p>相手に iPhone のカメラでこの QR を読んでもらってください</p>
              <QrCode url={started.joinUrl} />
              <p>相手の参加を待っています…</p>
              {error && <p role="alert">{error}</p>}
            </>
          }
        />
      </>
    )
  }

  return (
    <>
      <h1>対面交換</h1>
      <BackendWaking />
      <form onSubmit={onSubmit}>
        <label>
          場面（任意）
          <br />
          <input
            type="text"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            maxLength={OCCASION_MAX}
            placeholder="例：JPHACKS 2026 東京B"
          />
        </label>
        <p>
          <button type="submit" disabled={starting}>
            {starting ? 'はじめています…' : '交換をはじめる'}
          </button>
        </p>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
