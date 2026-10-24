// タブの画面の上に出す、ロゴと画面名
export default function PageHeader({ title }: { title: string }) {
  return (
    <header className="page-header">
      <span className="page-header-logo">
        <img src="/images/logo.png" alt="" width={55} height={55} />
        Pikkles
      </span>
      <h1 className="page-header-title">{title}</h1>
    </header>
  )
}
