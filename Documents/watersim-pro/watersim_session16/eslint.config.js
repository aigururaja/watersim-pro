// ─────────────────────────────────────────────────────────────────────────────
// ESLint v9 flat config for the WaterSim Pro monorepo (single root config).
//
//   backend/**       → CommonJS, Node globals (+ Jest globals in __tests__)
//   frontend/src/**  → ESM/JSX, browser globals, react + react-hooks plugins
//                      (+ Vitest globals in src/test — vite.config sets globals:true)
//   root/tooling     → config files (eslint/playwright/vite/postcss/tailwind), e2e specs
//
// Severity policy: recommended sets as the baseline; rules the existing codebase
// trips en masse are demoted to 'warn' so `npm run lint` gates on real bugs
// (no-undef, no-dupe-keys, react-hooks/rules-of-hooks stay 'error') without
// failing today. Do not mass auto-fix; tighten rules incrementally.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

// Pragmatic demotions shared by every section (existing code trips these widely).
const sharedTuning = {
  'no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

module.exports = [
  // ── Global ignores ──────────────────────────────────────────────────────────
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      'k8s/**',
      'nginx/**',
      'scripts/**', // shell scripts only
    ],
  },

  // ── Backend: Node/Express, CommonJS ─────────────────────────────────────────
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...sharedTuning,
    },
  },

  // ── Backend tests: add Jest globals ─────────────────────────────────────────
  {
    files: ['backend/src/__tests__/**/*.js', 'backend/jest.setup.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },

  // ── Frontend: React 18 + Vite, ESM/JSX ──────────────────────────────────────
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules, // new JSX transform: no React import needed
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/prop-types': 'off', // no PropTypes in this codebase
      'react/no-unescaped-entities': 'warn', // apostrophes/quotes in JSX copy
      'react/display-name': 'warn',
      ...sharedTuning,
    },
  },

  // ── Frontend tests: Vitest globals (vite.config.js test.globals = true) ─────
  {
    files: ['frontend/src/test/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
    },
  },

  // ── Root & workspace tooling configs, Playwright e2e specs ──────────────────
  {
    files: ['*.js', 'frontend/*.js', 'e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module', // Node globals below still cover require/module.exports
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...sharedTuning,
    },
  },
];
