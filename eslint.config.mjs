import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Underscore-prefixed names mark intentionally unused values, such as
      // options destructured only to keep them out of a spread.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true
      }]
    }
  },
  {
    files: ['test/**/*.mjs'],
    rules: {
      // Tests match column-aligned terminal output with literal spaces.
      'no-regex-spaces': 'off'
    }
  }
];
