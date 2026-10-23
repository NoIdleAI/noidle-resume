import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/** 后端端口（开发态 vite 代理 /api 与 WS；生产态由服务端直接托管 dist）。 */
const apiPort = Number(process.env.CAR_PORT ?? 7842);

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
