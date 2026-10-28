import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  base: './',
  // 老 Android WebView 只认更早的语法：默认 target（es2020）会留下 ?? 这类新语法，
  // Chrome 80 以下的机型整包解析失败、直接白屏。es2017 只多几 KB，换的是能打开。
  build: { target: 'es2017' },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
