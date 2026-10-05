import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const core = `http://127.0.0.1:${process.env.CANTINA_PORT ?? 4242}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': core,
      '/ws': { target: core.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
