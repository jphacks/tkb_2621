import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.tsx'
import ConsentGate, { useNeedsConsent } from './components/ConsentGate.tsx'
import PageHeader from './components/PageHeader.tsx'
import TabBar from './components/TabBar.tsx'
import { tutorialSeen } from './components/tutorial.ts'
import Loading from './components/Loading.tsx'
import Login from './pages/Login.tsx'
import OAuthCallback from './pages/OAuthCallback.tsx'

// ログインまわり以外の画面は開いたときに読み込み、最初に落とす JS を小さくする
const Timeline = lazy(() => import('./pages/Timeline.tsx'))
const Capture = lazy(() => import('./pages/Capture.tsx'))
const Binder = lazy(() => import('./pages/Binder.tsx'))
const BinderList = lazy(() => import('./pages/BinderList.tsx'))
const Exchange = lazy(() => import('./pages/Exchange.tsx'))
const ExchangeJoin = lazy(() => import('./pages/ExchangeJoin.tsx'))
const StickerDetail = lazy(() => import('./pages/StickerDetail.tsx'))
const FieldList = lazy(() => import('./pages/FieldList.tsx'))
const Field = lazy(() => import('./pages/Field.tsx'))
const FieldJoin = lazy(() => import('./pages/FieldJoin.tsx'))
const Tutorial = lazy(() => import('./pages/Tutorial.tsx'))
const Account = lazy(() => import('./pages/Account.tsx'))
const Terms = lazy(() => import('./pages/Terms.tsx'))
const Privacy = lazy(() => import('./pages/Privacy.tsx'))

// 上のヘッダーに出す画面名。ここにない画面（交換・ステッカー詳細）はヘッダーを出さない
function headerTitle(pathname: string): string | undefined {
  if (pathname === '/') return 'タイムライン'
  if (pathname === '/capture') return 'ピクルス作成'
  if (pathname.startsWith('/binder')) return 'ビン'
  if (pathname.startsWith('/fields')) return '共同フィールド'
  if (pathname === '/tutorial') return '使い方'
  if (pathname === '/account') return 'アカウント'
  return undefined
}

// 使い方へ送ってよい画面。交換や共同フィールドの参加（QR から来た人）は途中で止めないよう、ここに入れない
const TUTORIAL_FROM = ['/', '/capture', '/binder', '/binder/list', '/fields', '/account']

// ヘッダーとタブはスクロールの外に置き、いつも画面の上下に出しておく。同意の画面を出している間はどちらも隠す
function TabLayout() {
  const { pathname } = useLocation()
  const title = headerTitle(pathname)
  const auth = useAuth()
  const needsConsent = useNeedsConsent()
  // 同意が済んだあと、そのアカウントで初めてタブの画面を開いたら、先に使い方を見てもらう
  if (auth.status === 'signedIn' && !needsConsent && TUTORIAL_FROM.includes(pathname) && !tutorialSeen(auth.did)) {
    return <Navigate to="/tutorial" replace />
  }
  return (
    <>
      {title && !needsConsent && <PageHeader title={title} />}
      <main className="page">
        <ConsentGate>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </ConsentGate>
      </main>
      {!needsConsent && <TabBar />}
    </>
  )
}

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/login" element={<main className="page"><Login /></main>} />
        <Route path="/oauth/callback" element={<main className="page"><OAuthCallback /></main>} />
        <Route path="/terms" element={<main className="page"><Suspense fallback={<Loading />}><Terms /></Suspense></main>} />
        <Route path="/privacy" element={<main className="page"><Suspense fallback={<Loading />}><Privacy /></Suspense></main>} />
        <Route element={<TabLayout />}>
          <Route path="/" element={<Timeline />} />
          <Route path="/capture" element={<Capture />} />
          <Route path="/binder" element={<Binder />} />
          <Route path="/binder/list" element={<BinderList />} />
          <Route path="/exchange" element={<Exchange />} />
          <Route path="/exchange/join/:sessionId" element={<ExchangeJoin />} />
          <Route path="/exchange/:sessionId" element={<Exchange />} />
          <Route path="/sticker/:did/:rkey" element={<StickerDetail />} />
          <Route path="/fields" element={<FieldList />} />
          <Route path="/fields/join" element={<FieldJoin />} />
          <Route path="/fields/:did/:rkey" element={<Field />} />
          <Route path="/tutorial" element={<Tutorial />} />
          <Route path="/account" element={<Account />} />
        </Route>
      </Routes>
    </div>
  )
}
