// 使い方。撮影 → トリミング → 公開の確認をして保存 → ビンに貼る、までを1枚ずつ見せる。
// 初めてタブの画面を開いたときに一度だけここへ送る（App.tsx）。見終わる・スキップすると印を付け、次からは送らない。
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.tsx'
import { markTutorialSeen } from '../components/tutorial.ts'

interface Step {
  art: ReactNode
  title: string
  lines: string[]
}

const STEPS: Step[] = [
  {
    art: <img src="/images/shutter.svg" alt="" width={72} height={72} />,
    title: '「撮影」タブで撮る',
    lines: ['ピクルスにしたいモノを枠の中に入れて、シャッターを押します', '写真やイラスト（PNG）は「ファイルから選択」から選べます'],
  },
  {
    art: (
      <div className="tutorial-trim">
        <img src="/images/login-sticker-2.png" alt="" width={96} height={96} />
        <span className="tutorial-trim-frame">
          <span className="trim-handle trim-handle-nw" />
          <span className="trim-handle trim-handle-ne" />
          <span className="trim-handle trim-handle-sw" />
          <span className="trim-handle trim-handle-se" />
        </span>
      </div>
    ),
    title: '囲んで「決定」',
    lines: ['枠をドラッグで動かし、四隅のつまみで大きさを変えて、残したいところを囲みます', '「決定」を押すと、背景が自動で消えてピクルスになります'],
  },
  {
    art: <img src="/images/login-sticker-1.png" alt="" width={108} height={108} />,
    title: '確かめて保存する',
    lines: ['「どんな味？」にひとことを書けます（なくても大丈夫）', 'ピクルスは公開されます。「公開されることを確認しました」にチェックして「保存する」を押します'],
  },
  {
    art: (
      <div className="binder-jar tutorial-jar">
        <img src="/images/login-sticker-1.png" alt="" width={56} height={56} className="tutorial-jar-a" />
        <img src="/images/login-sticker-2.png" alt="" width={48} height={48} className="tutorial-jar-b" />
      </div>
    ),
    title: 'ビンに貼る',
    lines: [
      '保存するとビンの画面に移ります。下の「手持ちのピクルス」をタップすると、ビンの真ん中に貼れます',
      'ドラッグで動かし、取っ手か2本指で大きさと向きを変えられます。動かすと自動で保存されます',
      '貼ったものを選んで「はがす」と、ビンから外せます',
    ],
  },
]

export default function Tutorial() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [index, setIndex] = useState(0)
  const step = STEPS[index]
  const last = index === STEPS.length - 1

  function finish(to: string) {
    if (auth.status === 'signedIn') markTutorialSeen(auth.did)
    navigate(to, { replace: true })
  }

  return (
    <>
      <section className="card tutorial-card" aria-live="polite">
        <p className="tutorial-count">
          {index + 1} / {STEPS.length}
        </p>
        <div className="tutorial-art">{step.art}</div>
        <h2 className="tutorial-title">{step.title}</h2>
        {step.lines.map((line) => (
          <p key={line} className="tutorial-line">
            {line}
          </p>
        ))}
      </section>

      <div className="tutorial-dots" aria-hidden="true">
        {STEPS.map((s, i) => (
          <span key={s.title} className={i === index ? 'tutorial-dot active' : 'tutorial-dot'} />
        ))}
      </div>

      <div className="tutorial-actions">
        <button type="button" className="btn btn-block" onClick={() => setIndex(index - 1)} disabled={index === 0}>
          戻る
        </button>
        {last ? (
          <button type="button" className="btn btn-primary btn-block" onClick={() => finish('/capture')}>
            撮影してみる
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-block" onClick={() => setIndex(index + 1)}>
            次へ
          </button>
        )}
      </div>
      <button type="button" className="tutorial-skip" onClick={() => finish('/')}>
        {last ? 'タイムラインへ' : 'スキップ'}
      </button>
    </>
  )
}
