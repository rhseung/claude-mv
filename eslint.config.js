import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import checkFile from 'eslint-plugin-check-file';
import importPlugin from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NO_UI_DEPS = {
  patterns: [
    {
      group: ['ink', 'ink/*', '@inkjs/ui', 'react', 'react/*', 'chalk'],
      message:
        'headless 경로입니다. ink/react/chalk 는 src/render/ink 안에서만 씁니다. 출력은 Reporter 로 내보내세요.',
    },
  ],
};

export default [
  { ignores: ['dist', 'plugin/hooks/*.mjs', 'node_modules', 'coverage'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: {
      'import-x': importPlugin,
      'unused-imports': unusedImports,
      'check-file': checkFile,
    },
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        { 'src/**/*.{ts,tsx}': 'KEBAB_CASE', 'test/**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling'], 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  {
    files: ['src/hook/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...NO_UI_DEPS.patterns,
            {
              group: ['fs-extra', 'execa', 'tar', 'ps-list', 'citty', 'proper-lockfile'],
              message: '훅은 node 빌트인과 의존성 없는 core 모듈만 씁니다.',
            },
          ],
        },
      ],
    },
  },

  {
    files: [
      'src/core/**/*.ts',
      'src/commands/**/*.ts',
      'src/render/plain/**/*.ts',
      'src/render/json/**/*.ts',
    ],
    rules: { 'no-restricted-imports': ['error', NO_UI_DEPS] },
  },

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/shared/env.ts', 'src/hook/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.object.name="process"][object.property.name="env"][property.name!="TZ"]',
          message: 'process.env 는 src/shared/env.ts 에서만 읽습니다. 값은 인자로 받으세요.',
        },
        {
          selector: 'CallExpression[callee.property.name="homedir"]',
          message: 'os.homedir() 는 src/shared/env.ts 에서만 부릅니다.',
        },
      ],
    },
  },

  {
    files: ['*.config.{ts,js}', 'scripts/**/*.ts', 'test/setup.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },

  prettierConfig,
];
