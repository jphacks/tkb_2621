import { NavLink } from 'react-router-dom'

const tabs = [
  { to: '/', label: 'タイムライン', icon: 'timeline', end: true },
  { to: '/capture', label: '撮影', icon: 'capture', end: false },
  { to: '/binder', label: 'ビン', icon: 'binder', end: false },
  { to: '/fields', label: '共同フィールド', icon: 'fields', end: false },
]

export default function TabBar() {
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end} className="tab">
          <span className={`tab-icon tab-icon-${tab.icon}`} aria-hidden="true" />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
