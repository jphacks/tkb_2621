import { NavLink } from 'react-router-dom'

const tabs = [
  { to: '/', label: 'タイムライン', end: true },
  { to: '/capture', label: '撮影', end: false },
  { to: '/binder', label: 'シール帳', end: false },
  { to: '/fields', label: '共同フィールド', end: false },
]

export default function TabBar() {
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end} className="tab">
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
