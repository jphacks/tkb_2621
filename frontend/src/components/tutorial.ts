// 使い方を見たかどうか。アカウントごとに覚え、初めてタブの画面を開いたときに一度だけ使い方へ送るのに使う
const KEY_PREFIX = 'pikkles:tutorial-seen:'

// localStorage に残せない（プライベートブラウズなど）ときも、そのページを開いている間は見たことにする
const seenInMemory = new Set<string>()

export function tutorialSeen(did: string): boolean {
  if (seenInMemory.has(did)) return true
  try {
    return localStorage.getItem(KEY_PREFIX + did) !== null
  } catch {
    return false
  }
}

export function markTutorialSeen(did: string) {
  seenInMemory.add(did)
  try {
    localStorage.setItem(KEY_PREFIX + did, '1')
  } catch {
    // 残せなくても、このページを開いている間は seenInMemory で見たことになる
  }
}
