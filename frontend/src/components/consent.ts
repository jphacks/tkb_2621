// 利用規約とプライバシーポリシーに同意したかどうか。ログイン後、同意するまでは ConsentGate が同意の画面を出す

/** 規約・ポリシーの版。文面を変えたらここを上げると、全員にもう一度聞く */
export const TERMS_VERSION = '2026-10-27'

const KEY_PREFIX = 'pikkles:consent:'

// localStorage に残せない（プライベートブラウズなど）ときも、そのページを開いている間は同意済みにする
const agreedInMemory = new Set<string>()
const listeners = new Set<() => void>()

/** 同意した版が今の版と同じときだけ true */
export function hasConsented(did: string): boolean {
  if (agreedInMemory.has(did)) return true
  try {
    const raw = localStorage.getItem(KEY_PREFIX + did)
    if (raw === null) return false
    const saved = JSON.parse(raw) as { version?: unknown }
    return saved.version === TERMS_VERSION
  } catch {
    return false
  }
}

export function markConsented(did: string) {
  agreedInMemory.add(did)
  try {
    localStorage.setItem(KEY_PREFIX + did, JSON.stringify({ version: TERMS_VERSION, agreedAt: new Date().toISOString() }))
  } catch {
    // 残せなくても、このページを開いている間は agreedInMemory で同意済みになる
  }
  for (const listener of listeners) listener()
}

/** 同意したときに知らせる。useSyncExternalStore で使う */
export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
