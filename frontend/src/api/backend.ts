// バックエンド（backend/app）を呼ぶ部品。型は backend/app/schemas.py に合わせる。
import type { Agent } from '@atproto/api'
import { useSyncExternalStore } from 'react'
import { SERVICE_AUTH_LXM } from '../auth/scope.ts'
import type { Did, Exchange, StrongRef, Sticker } from '../lexicon-types.ts'

// ---- schemas.py と同じ形 ----

export type SessionStatus = 'waiting' | 'selecting' | 'confirmed' | 'completed' | 'cancelled'

export interface CreateSessionResponse {
  sessionId: string
  /** QR 用の参加URL（60秒で失効） */
  joinUrl: string
}

export interface SessionState {
  sessionId: string
  occasion: string | null
  status: SessionStatus
}

export interface CutoutResponse {
  /** base64 の透過PNG */
  image: string
  width: number
  height: number
}

export interface CommitResponse {
  result: 'completed' | 'waiting_partner' | 'failed'
  reason?: string | null
}

export interface ExchangeView {
  sessionId: string
  occasion: string | null
  partner: Did
  gave: StrongRef
  received: StrongRef
  createdAt: string
}

export interface FieldMembersResponse {
  members: Did[]
  /** 残りが0人になった・作った人が削除した。閉じたフィールドへの参加は 410 */
  closed: boolean
}

export interface OkResponse {
  ok: boolean
}

interface TimelineItemBase {
  /** 出来事を書いた人の DID */
  author: Did
  uri: string
  cid: string
  createdAt: string
}

export type TimelineItem =
  | (TimelineItemBase & { kind: 'sticker'; record: Sticker })
  | (TimelineItemBase & { kind: 'exchange'; record: Exchange })

export interface TimelineResponse {
  items: TimelineItem[]
  cursor?: string | null
}

export type ClientMessage = { type: 'select'; sticker: StrongRef } | { type: 'confirm' }

export type ServerMessage =
  | { type: 'partner_selected'; sticker: StrongRef }
  | { type: 'both_confirmed'; occasion: string | null }
  | { type: 'completed'; exchange: ExchangeView }
  | { type: 'cancelled'; reason: string }

// ---- 呼び出し ----

export class BackendError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'BackendError'
    this.status = status
  }
}

function env(name: 'VITE_BACKEND_URL' | 'VITE_BACKEND_DID'): string {
  const value = import.meta.env[name] as string | undefined
  if (!value) throw new Error(`${name} が設定されていません`)
  return value.replace(/\/$/, '')
}

/** JWT は60秒で切れるので、呼ぶたびに取り直す（使い回さない） */
async function getToken(agent: Agent): Promise<string> {
  const { data } = await agent.com.atproto.server.getServiceAuth({ aud: env('VITE_BACKEND_DID'), lxm: SERVICE_AUTH_LXM })
  return data.token
}

// Render が寝ていると最初の応答に30秒ほどかかる。3秒を超えた呼び出しがあれば「起こしている」とみなす
const SLOW_MS = 3000
let slowCount = 0
const listeners = new Set<() => void>()

function addSlow(delta: number) {
  slowCount += delta
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** サーバーの応答を3秒以上待っている間 true */
export function useBackendWaking(): boolean {
  return useSyncExternalStore(subscribe, () => slowCount > 0)
}

/** body が FormData なら multipart で、それ以外は JSON で送る */
async function backendFetch<T>(agent: Agent, path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<T> {
  const token = await getToken(agent)
  let slow = false
  const timer = setTimeout(() => {
    slow = true
    addSlow(1)
  }, SLOW_MS)
  try {
    const isForm = init.body instanceof FormData
    const isJson = init.body !== undefined && !isForm
    const res = await fetch(`${env('VITE_BACKEND_URL')}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        // multipart の Content-Type（boundary 付き）はブラウザに付けさせる
        ...(isJson ? { 'Content-Type': 'application/json' } : {}),
      },
      body: isForm ? (init.body as FormData) : isJson ? JSON.stringify(init.body) : undefined,
    })
    const data: unknown = await res.json().catch(() => undefined)
    if (!res.ok) {
      // FastAPI の HTTPException は {"detail": "…"}
      const detail = (data as { detail?: unknown } | undefined)?.detail
      throw new BackendError(res.status, typeof detail === 'string' ? detail : `サーバーエラー（${res.status}）`)
    }
    return data as T
  } finally {
    clearTimeout(timer)
    if (slow) addSlow(-1)
  }
}

/** 背景を消して透過PNGにする。画像はサーバーで再エンコードされ、EXIF などは残らない */
export function cutout(agent: Agent, file: File, source: Sticker['source']): Promise<CutoutResponse> {
  const form = new FormData()
  form.append('image', file)
  form.append('source', source)
  return backendFetch(agent, '/cutout', { method: 'POST', body: form })
}

export function createSession(agent: Agent, occasion: string | null): Promise<CreateSessionResponse> {
  return backendFetch(agent, '/exchange/sessions', { method: 'POST', body: { occasion } })
}

/** QR を作り直す。相手が参加済みなら 409 */
export function refreshQr(agent: Agent, sessionId: string): Promise<CreateSessionResponse> {
  return backendFetch(agent, `/exchange/sessions/${encodeURIComponent(sessionId)}/qr`, { method: 'GET' })
}

/** 410: QR の期限切れ / 403: ブロック関係 */
export function joinSession(agent: Agent, sessionId: string, t: string): Promise<SessionState> {
  return backendFetch(agent, `/exchange/sessions/${encodeURIComponent(sessionId)}/join`, { method: 'POST', body: { t } })
}

export function commitExchange(agent: Agent, sessionId: string, uri: string): Promise<CommitResponse> {
  return backendFetch(agent, `/exchange/sessions/${encodeURIComponent(sessionId)}/commit`, { method: 'POST', body: { uri } })
}

/** 呼んだ人を共同フィールドのメンバーとして登録する（spec 7章1のタイムライン用） */
export function joinField(agent: Agent, field: StrongRef): Promise<FieldMembersResponse> {
  return backendFetch(agent, '/fields/join', { method: 'POST', body: { field } })
}

export function getFieldMembers(agent: Agent, uri: string): Promise<FieldMembersResponse> {
  return backendFetch(agent, `/fields/members?${new URLSearchParams({ uri })}`, { method: 'GET' })
}

/** 呼んだ人をメンバーから外す。残りが0人なら closed: true */
export function leaveFieldOnServer(agent: Agent, uri: string): Promise<FieldMembersResponse> {
  return backendFetch(agent, `/fields/members?${new URLSearchParams({ uri })}`, { method: 'DELETE' })
}

/** メンバーを全部消して閉じる。作った人だけ */
export function deleteFieldOnServer(agent: Agent, uri: string): Promise<OkResponse> {
  return backendFetch(agent, `/fields?${new URLSearchParams({ uri })}`, { method: 'DELETE' })
}

/** 交換相手と共同フィールドのメンバーの出来事を新しい順に。続きは返ってきた cursor で読む */
export function getTimeline(agent: Agent, cursor?: string, limit = 30): Promise<TimelineResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return backendFetch(agent, `/timeline?${params}`, { method: 'GET' })
}

// ---- WebSocket ----

export interface ExchangeSocket {
  send: (message: ClientMessage) => void
  close: () => void
}

const RECONNECT_MS = 3000

/**
 * 交換の WebSocket。接続直後に {"type":"auth","token":…} を送る。
 * iPhone は画面を切り替えると接続が切れるので、閉じるまでつなぎ直す（サーバーは再接続時に相手の選択などを送り直す）。
 * 認証やセッションが通らない（4401/4403）ときはつなぎ直さず onRejected を呼ぶ。
 */
export function openExchangeSocket(
  agent: Agent,
  sessionId: string,
  handlers: { onMessage: (message: ServerMessage) => void; onRejected: () => void },
): ExchangeSocket {
  const url = `${env('VITE_BACKEND_URL').replace(/^http/, 'ws')}/exchange/sessions/${encodeURIComponent(sessionId)}/ws`
  let ws: WebSocket | undefined
  let closed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  // つながっていない間に送ったものは、つないだあとに送る
  const queue: ClientMessage[] = []

  function scheduleReconnect() {
    if (!closed) retry = setTimeout(connect, RECONNECT_MS)
  }

  async function connect() {
    let token: string
    try {
      token = await getToken(agent)
    } catch {
      scheduleReconnect()
      return
    }
    if (closed) return
    const socket = new WebSocket(url)
    ws = socket
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', token }))
      while (queue.length > 0) socket.send(JSON.stringify(queue.shift()))
    }
    socket.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(event.data as string) as ServerMessage)
      } catch {
        // 読めないメッセージは捨てる
      }
    }
    socket.onclose = (event) => {
      if (closed || ws !== socket) return
      if (event.code === 4401 || event.code === 4403) {
        handlers.onRejected()
        return
      }
      scheduleReconnect()
    }
  }

  void connect()

  return {
    send(message) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
      else queue.push(message)
    },
    close() {
      closed = true
      clearTimeout(retry)
      ws?.close()
    },
  }
}
