import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser, __STORAGE_LIMITS__: 'readonly' },
    },
  },
  {
    files: ['**/*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        FrameRequestCallback: 'readonly',
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
  },
  { files: ['**/*.{ts,vue}'], rules: { 'no-undef': 'error' } },
  {
    files: [
      'src/features/**/components/**/*.{ts,vue}',
      'src/shared/ui/**/*.{ts,vue}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '(?:^|[/@~])(?:services?|demo|offline|processing|repositories?|storage|containers|presenters)(?:/|$)|(?:Repository|Storage|worker)',
              caseSensitive: false,
              allowTypeImports: true,
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'confirm',
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'confirm' },
        { object: 'globalThis', property: 'confirm' },
        { object: 'self', property: 'confirm' },
        { property: 'localStorage' },
        { property: 'sessionStorage' },
        { property: 'indexedDB' },
      ],
    },
  },
  {
    files: ['src/features/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['vue', 'pinia', 'vue-router', 'reka-ui'] },
      ],
    },
  },
  prettier,
  {
    rules: {
      'curly': ['error', 'all'],
      'one-var': ['error', 'never'],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program > :not(ImportDeclaration) ~ ImportDeclaration',
          message:
            'Place static imports before declarations and executable code.',
        },
      ],
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: 'export', next: 'export' },
        {
          blankLine: 'always',
          prev: '*',
          next: [
            'return',
            'throw',
            'if',
            'for',
            'while',
            'switch',
            'try',
            'function',
            'class',
          ],
        },
        {
          blankLine: 'always',
          prev: ['if', 'for', 'while', 'switch', 'try', 'function', 'class'],
          next: '*',
        },
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['const', 'let'] },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
      ],
    },
  },
]
