import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // three.js грузится лениво (3D-превью). Без этого Vite в dev находит его только по клику,
  // пересобирает зависимости и перезагружает страницу.
  optimizeDeps: {
    include: [
      'three',
      'three/examples/jsm/controls/OrbitControls.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/environments/RoomEnvironment.js',
    ],
  },
})
