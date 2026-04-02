import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/orders': 'http://localhost:3000',
      '/order': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/refresh-token': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          socketio: ['socket.io-client'],
        },
      },
    },
  },
});
