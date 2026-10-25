// 画面を開いた直後の読み込み中。ロゴをゆっくり揺らして、止まっていないことを見せる
export default function Loading({ label = '読み込み中…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <img src="/images/logo.png" alt="" width={56} height={56} />
      <p>{label}</p>
    </div>
  )
}
