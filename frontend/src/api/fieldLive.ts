// 共同フィールドの変更をその場で受け取る。Bluesky の Jetstream（公開の書き込みの流れ）にブラウザから直接つなぐ。
// サーバーを通さないので Render が寝ていても動く。中身は署名を確かめていないので、画面側で定期的に PDS を読み直して正す。
import { NSID, type Did, type FieldPlacement } from '../lexicon-types.ts'
import { isFieldPlacement } from './field.ts'

// 公開の Jetstream。つながらなければ次のホストを試す
const HOSTS = [
  'jetstream2.us-east.bsky.network',
  'jetstream1.us-east.bsky.network',
  'jetstream1.us-west.bsky.network',
  'jetstream2.us-west.bsky.network',
]
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30_000

export type FieldPlacementEvent =
  | { type: 'put'; uri: string; author: Did; value: FieldPlacement }
  | { type: 'delete'; uri: string; author: Did }

interface JetstreamEvent {
  did?: unknown
  kind?: unknown
  commit?: { operation?: unknown; collection?: unknown; rkey?: unknown; record?: unknown }
}

function parse(data: unknown, fieldUri: string): FieldPlacementEvent | undefined {
  if (typeof data !== 'string') return undefined
  let event: JetstreamEvent
  try {
    event = JSON.parse(data) as JetstreamEvent
  } catch {
    return undefined
  }
  const { did, kind, commit } = event
  if (kind !== 'commit' || !commit || commit.collection !== NSID.fieldPlacement) return undefined
  if (typeof did !== 'string' || !did.startsWith('did:') || typeof commit.rkey !== 'string') return undefined
  const uri = `at://${did}/${NSID.fieldPlacement}/${commit.rkey}`
  // 消したときは中身が来ないので、どのフィールドのものかは画面側で uri から見る
  if (commit.operation === 'delete') return { type: 'delete', uri, author: did }
  if (commit.operation !== 'create' && commit.operation !== 'update') return undefined
  if (!isFieldPlacement(commit.record, fieldUri)) return undefined
  return { type: 'put', uri, author: did, value: commit.record }
}

/**
 * fieldUri を指す field.placement の作成・書き直しと、field.placement の削除（フィールドを問わない）を受け取る。
 * 切れたらつなぎ直し、つなぎ直せたら onReconnect を呼ぶ（切れていたあいだの分は読み直してもらう）。返り値で止める。
 */
export function subscribeFieldPlacements(
  fieldUri: string,
  handlers: { onEvent: (event: FieldPlacementEvent) => void; onReconnect: () => void },
): () => void {
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let everOpened = false
  let attempt = 0

  function connect() {
    const host = HOSTS[attempt % HOSTS.length]
    const ws = new WebSocket(`wss://${host}/subscribe?${new URLSearchParams({ wantedCollections: NSID.fieldPlacement })}`)
    socket = ws
    ws.onopen = () => {
      attempt = 0
      if (everOpened) handlers.onReconnect()
      everOpened = true
    }
    ws.onmessage = (message) => {
      const event = parse(message.data, fieldUri)
      if (event) handlers.onEvent(event)
    }
    // onerror のあとには必ず onclose が来るので、つなぎ直しは onclose だけで行う
    ws.onclose = () => {
      if (stopped) return
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt)
      attempt += 1
      retry = setTimeout(connect, delay)
    }
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retry)
    socket?.close()
  }
}
