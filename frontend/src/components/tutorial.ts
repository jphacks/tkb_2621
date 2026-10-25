// 使い方を見たかどうか。初めてタイムラインを開いたときだけ使い方へ送るのに使う
const SEEN_KEY = 'pikkles:tutorial-seen'

/** 見たかどうかはブラウザに残す。読めない（プライベートブラウズなど）ときは見たことにして、毎回は出さない */
export function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null
  } catch {
    return true
  }
}

export function markTutorialSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // 残せなくても使い方はそのまま閉じる
  }
}
