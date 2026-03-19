import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/plugin/',
  build: {
    outDir: '../public/plugin',
    emptyOutDir: true,
  },
});
