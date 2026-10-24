import { NSID } from '../lexicon-types.ts'

/**
 * getServiceAuth で発行するJWTの lxm（どのメソッド用のトークンか）。
 * PDS は scope の rpc:<lxm>?aud=<aud> と getServiceAuth の lxm・aud を突き合わせる。
 * lxm を省くと「全メソッド用」扱いになり、細かい scope では通らないので、必ずこれを付けて呼ぶ。
 * バックエンドはこの値の lxm を受け付ける必要がある。
 */
export const SERVICE_AUTH_LXM = 'com.kosora623.pikkles.api'

/**
 * 必要な分だけの細かい scope。
 * - repo: は「com.kosora623.pikkles.*」のようなワイルドカードを書けないので、コレクションを1つずつ並べる
 * - app.bsky.graph.follow は交換成立後の「Blueskyでもフォローする」（spec 3章 #13）
 * - blob:image/* は画像のアップロード
 * - rpc: の aud を * にしておくと、バックエンドの DID を client-metadata.json に書かずに済む
 */
export const GRANULAR_SCOPE = [
  'atproto',
  ...Object.values(NSID).map((collection) => `repo:${collection}`),
  'repo:app.bsky.graph.follow',
  'blob:image/*',
  `rpc:${SERVICE_AUTH_LXM}?aud=*`,
].join(' ')

export const GENERIC_SCOPE = 'atproto transition:generic'

/**
 * ログインで要求する scope。細かい scope で getServiceAuth などが通らなければ GENERIC_SCOPE に替える。
 * 本番の client-metadata.json の scope には両方を含めてあるので、ここを変えるだけで切り替わる。
 * GRANULAR_SCOPE を変えたら client-metadata.json の scope も合わせる。
 */
export const OAUTH_SCOPE: string = GRANULAR_SCOPE
// export const OAUTH_SCOPE: string = GENERIC_SCOPE
