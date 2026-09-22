import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // 훅 번들은 plugin/ 안에 산출물로 커밋된다. 플러그인 설치는 git clone 이라
    // node_modules 도 빌드 단계도 없어서, 의존성을 전부 인라인해야 단독 실행된다.
    entry: { 'session-start': 'src/hook/session-start.ts' },
    outDir: 'plugin/hooks',
    format: ['esm'],
    target: 'node20',
    outExtension: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    // 켜면 같은 디렉터리에 손으로 쓴 hooks.json 이 지워진다.
    clean: false,
  },
]);
