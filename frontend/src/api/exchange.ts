// 交換のときに相手へ渡す一言（docs/sticker-detail.md 6章）。相手の一言は相手の PDS の exchange にある
import { NSID, type Did, type Exchange } from '../lexicon-types.ts'
import { listPublicRecords } from './binder.ts'

/** 一言の上限（書記素の数） */
export const MESSAGE_MAX = 100

/** 相手が同じ交換の記録に書いた一言。無い・空・読めないときは undefined */
export async function getPartnerMessage(partner: Did, sessionId: string): Promise<string | undefined> {
  const records = await listPublicRecords<Exchange>(partner, NSID.exchange)
  return records.find((r) => r.value.sessionId === sessionId)?.value.message?.trim() || undefined
}
