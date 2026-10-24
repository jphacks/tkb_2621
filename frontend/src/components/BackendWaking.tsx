import { useBackendWaking } from '../api/backend.ts'

/** Render が寝ていて応答が遅いときに出す */
export default function BackendWaking() {
  const waking = useBackendWaking()
  if (!waking) return null
  return <p role="status">サーバーを起こしています…（30秒ほどかかることがあります）</p>
}
