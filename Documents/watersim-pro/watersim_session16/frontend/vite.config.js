import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy vendors into stable, cacheable chunks.
        manualChunks(id) {
          const nid = id.split('\\').join('/');
          if (!nid.includes('node_modules')) return undefined;
          if (nid.includes('/reactflow/') || nid.includes('/@reactflow/')) return 'reactflow';
          if (nid.includes('/recharts/') || nid.includes('/recharts-scale/') ||
              nid.includes('/d3-') || nid.includes('/victory-vendor/') ||
              nid.includes('/react-smooth/')) return 'recharts';
          if (nid.includes('/react/') || nid.includes('/react-dom/') ||
              nid.includes('/scheduler/')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
});
