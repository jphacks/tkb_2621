// タブを替えると画面が作り直され、読んだものが消える。前に読んだ結果をここに残し、戻ったときはまずそれを出す。
// 読み直しは各画面が裏で行い、読めたら差し替える。ページを読み込み直すと消える（ブラウザには保存しない）
const store = new Map<string, unknown>()

/** key が undefined（ログイン前）なら何も返さない */
export function readCache<T>(key: string | undefined): T | undefined {
  return key === undefined ? undefined : (store.get(key) as T | undefined)
}

export function writeCache(key: string | undefined, value: unknown): void {
  if (key !== undefined) store.set(key, value)
}
