import { Outlet, Route, Routes } from 'react-router-dom'
import TabBar from './components/TabBar.tsx'
import Login from './pages/Login.tsx'
import Timeline from './pages/Timeline.tsx'
import Capture from './pages/Capture.tsx'
import Binder from './pages/Binder.tsx'
import Exchange from './pages/Exchange.tsx'
import ExchangeJoin from './pages/ExchangeJoin.tsx'
import StickerDetail from './pages/StickerDetail.tsx'
import FieldList from './pages/FieldList.tsx'
import Field from './pages/Field.tsx'
import FieldJoin from './pages/FieldJoin.tsx'
import OAuthCallback from './pages/OAuthCallback.tsx'

function TabLayout() {
  return (
    <>
      <main className="page">
        <Outlet />
      </main>
      <TabBar />
    </>
  )
}

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/login" element={<main className="page"><Login /></main>} />
        <Route path="/oauth/callback" element={<main className="page"><OAuthCallback /></main>} />
        <Route element={<TabLayout />}>
          <Route path="/" element={<Timeline />} />
          <Route path="/capture" element={<Capture />} />
          <Route path="/binder" element={<Binder />} />
          <Route path="/exchange" element={<Exchange />} />
          <Route path="/exchange/join/:sessionId" element={<ExchangeJoin />} />
          <Route path="/exchange/:sessionId" element={<Exchange />} />
          <Route path="/sticker/:did/:rkey" element={<StickerDetail />} />
          <Route path="/fields" element={<FieldList />} />
          <Route path="/fields/join" element={<FieldJoin />} />
          <Route path="/fields/:did/:rkey" element={<Field />} />
        </Route>
      </Routes>
    </div>
  )
}
