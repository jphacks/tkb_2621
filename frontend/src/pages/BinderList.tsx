// ビンの「一覧」。手持ちのピクルス（自分で作ったもの＋交換でもらったもの）を並べ、押すとピクルス詳細へ。
// 読み込みはビンと同じ listOwnedStickers で、キャッシュもビンと共有する（先にビンを開いていればすぐ出る）。
import { AtUri } from '@atproto/api'
import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { listOwnedStickers, type OwnedSticker } from '../api/binder.ts'
import { readCache, writeCache } from '../api/screenCache.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import Loading from '../components/Loading.tsx'
import PageHeader from '../components/PageHeader.tsx'
import { ProfileAvatar } from '../components/Profile.tsx'

function stickerPath(uri: string): string {
  const at = new AtUri(uri)
  return `/sticker/${encodeURIComponent(at.host)}/${encodeURIComponent(at.rkey)}`
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function PickleGrid({ stickers, showOwner }: { stickers: OwnedSticker[]; showOwner: boolean }) {
  return (
    <ul className="pickle-grid">
      {stickers.map((sticker) => (
        <li key={sticker.ref.uri}>
          <Link to={stickerPath(sticker.ref.uri)} className="pickle-grid-item">
            <span className="pickle-grid-image">
              <img src={sticker.imageUrl} alt="" />
              {showOwner && (
                <span className="binder-hand-owner">
                  <ProfileAvatar did={sticker.owner} />
                </span>
              )}
            </span>
            <span className="pickle-grid-caption">{sticker.sticker.caption || '名前なし'}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default function BinderList() {
  const auth = useAuth()
  const agent = auth.status === 'signedIn' ? auth.agent : undefined
  const did = auth.status === 'signedIn' ? auth.did : undefined

  const [owned, setOwned] = useState(() => readCache<OwnedSticker[]>(did && `binder-owned:${did}`))
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!agent || !did) return
    let cancelled = false
    listOwnedStickers(agent, did)
      .then((list) => {
        writeCache(`binder-owned:${did}`, list)
        if (!cancelled) setOwned(list)
      })
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [agent, did])

  if (auth.status === 'loading') return <Loading />
  if (auth.status === 'signedOut') return <Navigate to="/login" replace />

  const mine = owned?.filter((s) => s.owner === did) ?? []
  const received = owned?.filter((s) => s.owner !== did) ?? []

  return (
    <>
      <PageHeader title="ビン" />
      <div className="back-header">
        <Link to="/binder" className="icon-button" aria-label="ビンにもどる">
          <img src="/images/back.svg" alt="" width={13} height={18} />
        </Link>
        <h1>ピクルス一覧</h1>
      </div>

      {error && <p role="alert">読めませんでした：{error}</p>}
      {!owned && !error && <Loading />}
      {owned?.length === 0 && (
        <p className="notice">
          まだピクルスがありません。<Link to="/capture">撮影する</Link>
        </p>
      )}

      {mine.length > 0 && (
        <section className="pickle-section">
          <h2 className="section-title">
            自分で作ったピクルス <span className="pickle-count">{mine.length}枚</span>
          </h2>
          <PickleGrid stickers={mine} showOwner={false} />
        </section>
      )}
      {received.length > 0 && (
        <section className="pickle-section">
          <h2 className="section-title">
            交換でもらったピクルス <span className="pickle-count">{received.length}枚</span>
          </h2>
          <PickleGrid stickers={received} showOwner />
        </section>
      )}
    </>
  )
}
