import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ink 는 React 런타임과 터미널 드라이버를 통째로 끌고 온다. SessionStart 훅과 --json 경로가
// 이걸 건드리면 훅이 수십 ms 느려지고 파이프 출력이 ANSI 로 더러워진다. 문서로만 두면 깨진다.
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
    plugins: { 'import-x': importPlugin, 'unused-imports': unusedImports },
    rules: {
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
    // 훅은 SessionStart 마다 돈다. 무거운 걸 끌어오면 모든 세션 시작이 그만큼 느려지고,
    // 단독 .mjs 로 번들되므로 의존성이 그대로 번들 크기가 된다.
    // 실제 크기 상한은 test/hook-bundle.test.ts 가 지킨다 - 이건 눈에 띄는 것만 막는 1 차 방어다.
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
    // 경로 해석이 테스트에서 진짜 홈 디렉터리로 새는 걸 막는다. 실수 하나가 사용자의
    // ~/.claude 를 건드리는 도구라 컨벤션으로 두지 않는다.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    // src/hook 은 의존성 0 으로 단독 .mjs 번들이 되어야 해서 shared/env.ts 를
    // import 할 수 없다 (그쪽은 env-paths 를 끌어온다). 그래서 환경을 직접 읽는다.
    ignores: ['src/shared/env.ts', 'src/hook/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name="process"][property.name="env"]',
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
