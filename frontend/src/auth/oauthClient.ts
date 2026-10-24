import { BrowserOAuthClient, buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-client-browser'
import { OAUTH_SCOPE } from './scope.ts'

export const CALLBACK_PATH = '/oauth/callback'
const PRODUCTION_CLIENT_ID = 'https://pikkles.kosora623.com/client-metadata.json'
const HANDLE_RESOLVER = 'https://bsky.social'

// ループバック方式は localhost ではなく 127.0.0.1 で開く決まりなので、localhost で開いたら移す
if (window.location.hostname === 'localhost') {
  const url = new URL(window.location.href)
  url.hostname = '127.0.0.1'
  window.location.replace(url)
}

function isLoopback(): boolean {
  return ['127.0.0.1', '[::1]'].includes(window.location.hostname)
}

async function createClient(): Promise<BrowserOAuthClient> {
  if (isLoopback()) {
    // ローカル開発：client_id を公開せず、scope と redirect_uri を client_id に埋め込むループバック方式
    return new BrowserOAuthClient({
      handleResolver: HANDLE_RESOLVER,
      clientMetadata: buildAtprotoLoopbackClientMetadata({
        scope: OAUTH_SCOPE,
        redirect_uris: [`${window.location.origin}${CALLBACK_PATH}`],
      }),
    })
  }
  return BrowserOAuthClient.load({ clientId: PRODUCTION_CLIENT_ID, handleResolver: HANDLE_RESOLVER })
}

let clientPromise: Promise<BrowserOAuthClient> | undefined

/** OAuth クライアントは1つだけ作る（StrictMode で effect が2回走っても同じものを返す） */
export function getOAuthClient(): Promise<BrowserOAuthClient> {
  clientPromise ??= createClient()
  return clientPromise
}
