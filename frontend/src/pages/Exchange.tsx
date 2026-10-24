// S5 対面交換：始める側（A）。場面を入れてセッションを作り、参加用の QR を出す。
import QRCode from 'qrcode'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
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
  return <img src={dataUrl} alt="参加用の QR コード" className="exchange-qr-image" />
}

/** QR と、次の QR に替わるまでの残り時間。URL が替わるたびに key で作り直して数え直す */
function QrCard({ url }: { url: string }) {
  const [shownAt] = useState(() => Date.now())
  const [now, setNow] = useState(shownAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const total = QR_REDRAW_MS / 1000
  const remaining = Math.max(0, total - Math.floor((now - shownAt) / 1000))
  return (
    <div className="card exchange-qr">
      <p>相手にこのQRを読んでもらおう…</p>
      <QrCode url={url} />
      <div className="progress" aria-hidden="true">
        <span style={{ width: `${(remaining / total) * 100}%` }} />
      </div>
      <p className="text-muted">{remaining > 0 ? `あと${remaining}秒で新しいQRに切り替わります…` : 'まもなく新しいQRに切り替わります…'}</p>
    </div>
  )
}

/** 相手の QR を読む方法。アプリの中で読み取る機能はまだ無いので、iPhone のカメラで読むように案内する */
function ScanPartner() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="or-divider">または</div>
      {open && (
        <div className="notice exchange-scan-hint">
          <p className="notice-title">相手の QR を iPhone のカメラで読み取ってください</p>
          <p>カメラアプリを開いて相手の画面の QR に向けると、交換に参加するページが開きます</p>
        </div>
      )}
      <button type="button" className="btn btn-block exchange-scan" onClick={() => setOpen(!open)} aria-expanded={open}>
        <img src="/images/scan.svg" alt="" width={12} height={12} />
        相手のQRを読み取る
      </button>
    </>
  )
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
              <QrCard key={started.joinUrl} url={started.joinUrl} />
              <p role="status" className="text-muted exchange-status">
                相手の参加を待っています…
              </p>
              {error && <p role="alert">{error}</p>}
              <ScanPartner />
            </>
          }
        />
      </>
    )
  }

  return (
    <>
      <div className="back-header">
        <Link to="/binder" className="icon-button" aria-label="ビンにもどる">
          <img src="/images/back.svg" alt="" width={13} height={18} />
        </Link>
        <h1>対面で交換</h1>
      </div>
      <BackendWaking />
      <form onSubmit={onSubmit}>
        <label className="exchange-occasion">
          場面（任意）
          <input
            type="text"
            className="input"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            maxLength={OCCASION_MAX}
            placeholder="例：JPHACKS 2026 東京B"
          />
        </label>
        <p className="exchange-occasion-help">
          <span>二人の交換記録に同じ場面が入ります</span>
          <span className="capture-count">
            {occasion.length}/{OCCASION_MAX}
          </span>
        </p>
        <button type="submit" className="btn btn-primary btn-block" disabled={starting}>
          {starting ? 'はじめています…' : 'QRを出す'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <ScanPartner />
    </>
  )
}
