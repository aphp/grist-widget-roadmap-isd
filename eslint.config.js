import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['docs/**', 'schema/**', 'dev/data/**', 'node_modules/**', 'widget/vendor/**'] },
  js.configs.recommended,
  {
    files: ['widget/**/*.js', 'dev/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser, grist: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Script classique (non module) chargé dans <head> avant les styles
    files: ['widget/js/theme-boot.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
];
