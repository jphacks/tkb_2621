// DID を @handle にして出す。引けない間は DID のまま
import { useEffect, useState } from 'react'
import { resolveDid } from '../api/sticker.ts'
import type { Did } from '../lexicon-types.ts'

export default function Handle({ did }: { did: Did }) {
  const [handle, setHandle] = useState<string>()

  useEffect(() => {
    let cancelled = false
    resolveDid(did)
      .then((info) => !cancelled && setHandle(info.handle))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [did])

  return <>{handle ? `@${handle}` : did}</>
}
