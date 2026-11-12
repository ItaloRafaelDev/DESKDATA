import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Convenção já usada no projeto: prefixo "_" indica valor descartado de propósito
// (ex.: `({account:_account,...record})` para remover campos antes de enviar ao renderer).
const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true
};

export default defineConfig([
  globalIgnores(['node_modules/**', 'out/**', 'dist/**', 'release/**', 'coverage/**', 'backups/**', 'examples/**']),
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended],
    rules: { 'no-unused-vars': ['error', unusedVarsOptions] }
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: { '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions] }
  },
  {
    // Processo principal, preload, scripts e configuração rodam em Node.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**/*.mjs', 'electron.vite.config.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    // Testes rodam em Node, mas parte dos callbacks é executada no DOM simulado/portal (page.evaluate).
    files: ['tests/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
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
