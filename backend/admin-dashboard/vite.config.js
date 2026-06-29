import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'strip-crossorigin',
      transformIndexHtml(html) {
        return html.replace(/\s+crossorigin/g, '');
      },
    },
  ],
  base: '/admin/dashboard/',
  server: { port: 3001 },
});
