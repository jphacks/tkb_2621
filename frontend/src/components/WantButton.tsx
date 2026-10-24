// 他人のステッカーに「ほしい」を付け外しするボタン。自分のステッカーには出さない
import { AtUri, type Agent } from '@atproto/api'
import { useEffect, useState } from 'react'
import { addWant, getMyWants, removeWant } from '../api/want.ts'
import type { Did, StrongRef } from '../lexicon-types.ts'

export default function WantButton({ agent, did, subject }: { agent: Agent; did: Did; subject: StrongRef }) {
  const [wanted, setWanted] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const own = new AtUri(subject.uri).host === did

  useEffect(() => {
    if (own) return
    let cancelled = false
    getMyWants(agent, did)
      .then((wants) => !cancelled && setWanted(wants.has(subject.uri)))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [agent, did, subject.uri, own])

  if (own) return null

  async function toggle() {
    setBusy(true)
    setFailed(false)
    try {
      if (wanted) await removeWant(agent, did, subject.uri)
      else await addWant(agent, did, subject)
      setWanted(!wanted)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        className={wanted ? 'want-button wanted' : 'want-button'}
        onClick={() => void toggle()}
        disabled={busy || wanted === undefined}
        aria-pressed={wanted ?? false}
      >
        <img src={wanted ? '/images/star-filled.svg' : '/images/star.svg'} alt="" width={11} height={11} />
        {wanted ? 'ほしい済み' : 'ほしい'}
      </button>
      {failed && <small role="alert">できませんでした</small>}
    </span>
  )
}
