import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/plugin/',
  build: {
    outDir: '../public/plugin',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Proxy les appels /api vers le backend Next.js en dev
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
