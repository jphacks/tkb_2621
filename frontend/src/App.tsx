import { Outlet, Route, Routes, useLocation } from 'react-router-dom'
import ConsentGate, { useNeedsConsent } from './components/ConsentGate.tsx'
import PageHeader from './components/PageHeader.tsx'
import TabBar from './components/TabBar.tsx'
import Login from './pages/Login.tsx'
import Timeline from './pages/Timeline.tsx'
import Capture from './pages/Capture.tsx'
import Binder from './pages/Binder.tsx'
import BinderList from './pages/BinderList.tsx'
import Exchange from './pages/Exchange.tsx'
import ExchangeJoin from './pages/ExchangeJoin.tsx'
import StickerDetail from './pages/StickerDetail.tsx'
import FieldList from './pages/FieldList.tsx'
import Field from './pages/Field.tsx'
import FieldJoin from './pages/FieldJoin.tsx'
import Tutorial from './pages/Tutorial.tsx'
import OAuthCallback from './pages/OAuthCallback.tsx'
import Terms from './pages/Terms.tsx'
import Privacy from './pages/Privacy.tsx'

// 上のヘッダーに出す画面名。ここにない画面（交換・ステッカー詳細）はヘッダーを出さない
function headerTitle(pathname: string): string | undefined {
  if (pathname === '/') return 'タイムライン'
  if (pathname === '/capture') return 'ピクルス作成'
  if (pathname.startsWith('/binder')) return 'ビン'
  if (pathname.startsWith('/fields')) return '共同フィールド'
  if (pathname === '/tutorial') return '使い方'
  return undefined
}

// ヘッダーとタブはスクロールの外に置き、いつも画面の上下に出しておく。同意の画面を出している間はどちらも隠す
function TabLayout() {
  const title = headerTitle(useLocation().pathname)
  const needsConsent = useNeedsConsent()
  return (
    <>
      {title && !needsConsent && <PageHeader title={title} />}
      <main className="page">
        <ConsentGate>
          <Outlet />
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
        <Route path="/terms" element={<main className="page"><Terms /></main>} />
        <Route path="/privacy" element={<main className="page"><Privacy /></main>} />
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
        </Route>
      </Routes>
    </div>
  )
}
