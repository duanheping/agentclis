import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

export default defineConfig(() => {
  const inVitest = Boolean(process.env.VITEST)

  return {
    plugins: inVitest
      ? [react()]
      : [
          react(),
          electron({
            main: {
              entry: 'electron/main.ts',
              vite: {
                build: {
                  rollupOptions: {
                    // Native Node modules like node-pty must stay external so
                    // they can load their bundled .node binaries at runtime.
                    external: ['node-pty'],
                  },
                },
              },
            },
            preload: {
              input: 'electron/preload.ts',
            },
            renderer: {},
          }),
        ],
    build: {
      outDir: 'dist',
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
    },
  }
})
