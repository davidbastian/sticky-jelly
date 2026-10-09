import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Relative asset paths, because the packaged app loads the build from disk
 * with file:// rather than from a server — absolute paths resolve to the root
 * of the filesystem there and nothing loads.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  /* Two pages: the creature, and its Settings window. */
  build: { rollupOptions: { input: { main: 'index.html', settings: 'settings.html' } } },
});
