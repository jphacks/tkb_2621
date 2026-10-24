import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Did } from '../lexicon-types.ts'
import { getOAuthClient } from './oauthClient.ts'
import { OAUTH_SCOPE } from './scope.ts'

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut'; error?: string }
  | { status: 'signedIn'; session: OAuthSession; agent: Agent; did: Did; handle: string }

type AuthContextValue = AuthState & {
  signIn: (handle: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** 再読み込みのたびに init が走らないよう、ページ読み込みごとに1回だけ実行する（コールバックの二重処理も防ぐ） */
let initPromise: ReturnType<typeof initSession> | undefined

async function initSession() {
  const client = await getOAuthClient()
  const result = await client.init()
  return result?.session
}

async function toSignedIn(session: OAuthSession): Promise<AuthState> {
  const agent = new Agent(session)
  let handle: string = session.did
  try {
    const { data } = await agent.com.atproto.repo.describeRepo({ repo: session.did })
    handle = data.handle
  } catch {
    // ハンドルが引けなくてもログイン自体は続ける
  }
  return { status: 'signedIn', session, agent, did: session.did, handle }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    initPromise ??= initSession()
    initPromise
      .then((session) => (session ? toSignedIn(session) : ({ status: 'signedOut' } as const)))
      .catch((e: unknown) => ({ status: 'signedOut', error: errorMessage(e) }) as const)
      .then((next) => {
        if (!cancelled) setState(next)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async (handle: string) => {
    const client = await getOAuthClient()
    // 戻ってこない（Bluesky の認可画面へ移動する）
    await client.signInRedirect(handle, { scope: OAUTH_SCOPE })
  }, [])

  const signOut = useCallback(async () => {
    if (state.status !== 'signedIn') return
    try {
      await state.session.signOut()
    } finally {
      setState({ status: 'signedOut' })
    }
  }, [state])

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react/only-export-components
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth は AuthProvider の中で使う')
  return value
}
