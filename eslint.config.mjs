import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['node_modules/**', 'out/**', 'dist/**', 'release/**', 'coverage/**', 'backups/**', 'examples/**']),
  { files: ['**/*.{js,mjs,cjs,ts,tsx}'], extends: [js.configs.recommended] },
  { files: ['**/*.{ts,tsx}'], extends: [tseslint.configs.recommended] },
  {
    // Processo principal, preload, testes, scripts e configuração rodam em Node.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.mjs', 'scripts/**/*.mjs', 'electron.vite.config.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
]);
