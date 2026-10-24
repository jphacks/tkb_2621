import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // OAuth のループバック方式は localhost ではなく 127.0.0.1 で開く
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
