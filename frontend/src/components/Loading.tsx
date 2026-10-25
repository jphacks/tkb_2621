// 画面を開いた直後や、画面の中身を読み込んでいるあいだに出すローディング。
// 下のタブ以外を半透明でおおい、真ん中のピクルスの輪切りの種を1つずつ色づけて、ぐるっと回っているように見せる。
import { useLayoutEffect, useRef } from 'react'

/** 種の向き（時計回り）。この順に色づける */
const SEED_ANGLES = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]
/** 種1つぶんの遅れ（秒）。8つで1周 */
const SEED_STEP = 0.15

function PickleSpinner() {
  return (
    <svg className="pickle-spinner" viewBox="0 0 1024 1024" width={96} height={96} aria-hidden="true">
      <g transform="translate(512 512)">
        <circle r="471" fill="#4E7F33" />
        <circle r="422.5" fill="#A6CF6E" />
        <circle r="259.5" fill="#D6EAB0" />
        <g className="pickle-seeds">
          {SEED_ANGLES.map((angle, i) => (
            // 負の遅れにして、開いた瞬間から回っている途中の見た目にする
            <ellipse
              key={angle}
              cy="-171.4"
              rx="28.6"
              ry="52.8"
              transform={`rotate(${angle})`}
              style={{ animationDelay: `${(i - SEED_ANGLES.length) * SEED_STEP}s` }}
            />
          ))}
        </g>
      </g>
    </svg>
  )
}

export default function Loading({ label = '読み込み中…' }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  // 画面（.app）の幅に合わせ、下のタブ（選んでいるタブの飛び出しも含む）の上までをおおう。タブが無い画面は下まで
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    function fit() {
      if (!el) return
      const app = document.querySelector('.app')?.getBoundingClientRect()
      const tabTops = [...document.querySelectorAll('.tabbar, .tabbar .tab')].map((tab) => tab.getBoundingClientRect().top)
      el.style.left = app ? `${app.left}px` : '0px'
      el.style.width = app ? `${app.width}px` : '100%'
      el.style.bottom = tabTops.length > 0 ? `${window.innerHeight - Math.min(...tabTops)}px` : '0px'
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div ref={ref} className="loading" role="status">
      <PickleSpinner />
      <p>{label}</p>
    </div>
  )
}
