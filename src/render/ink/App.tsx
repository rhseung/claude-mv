import { ConfirmInput, Spinner } from '@inkjs/ui';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import stringWidth from 'string-width';

import { describeStep, duration, pad } from '../format.js';

import type { Store } from './store.js';

function useStore(store: Store) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.state;
}

const MARK = { pending: '-', running: ' ', done: 'v', failed: 'x' } as const;
const COLOR = { pending: 'gray', running: 'cyan', done: 'green', failed: 'red' } as const;

export function App({ store }: { store: Store }) {
  const state = useStore(store);
  if (!state.plan) return null;

  const rows = state.steps.map((entry) => {
    const described = describeStep(entry.step);
    return { ...entry, described };
  });

  // 한글 라벨은 터미널에서 두 칸이라 문자 수로 재면 열이 어긋난다.
  const labelWidth = Math.max(...rows.map((r) => stringWidth(r.described.label)), 12);
  const actionWidth = Math.max(...rows.map((r) => stringWidth(r.described.action)), 6);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text dimColor>from </Text>
          {state.plan.request.src}
        </Text>
        <Text>
          <Text dimColor> to </Text>
          {state.plan.request.dst}
        </Text>
      </Box>

      {rows.map((row, index) => (
        <Box key={`${row.step.id}-${index}`}>
          <Text color={COLOR[row.status]}>
            {row.status === 'running' ? <Spinner /> : ` ${MARK[row.status]} `}
          </Text>
          <Text> {pad(row.described.label, labelWidth + 2)}</Text>
          <Text dimColor>{pad(row.described.action, actionWidth + 2)}</Text>
          <Text dimColor>{row.detail ?? row.described.detail}</Text>
        </Box>
      ))}

      {state.plan.proseLeftBehind > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {`  대화 본문의 경로 ${state.plan.proseLeftBehind}곳은 그대로 둡니다 (--rewrite-prose 로 포함)`}
          </Text>
        </Box>
      )}

      {state.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {state.warnings.map((warning, index) => (
            <Text key={index} color="yellow">
              {`  ! ${warning}`}
            </Text>
          ))}
        </Box>
      )}

      {state.backupId && !state.outcome && (
        <Box marginTop={1}>
          <Text dimColor>{`  백업  ${state.backupId}`}</Text>
        </Box>
      )}

      {state.question && (
        <Box marginTop={1}>
          <Text>{`  ${state.question} `}</Text>
          <ConfirmInput
            onConfirm={() => store.answer?.(true)}
            onCancel={() => store.answer?.(false)}
          />
        </Box>
      )}

      {state.notes.map((note, index) => (
        <Text key={index}>{`  ${note}`}</Text>
      ))}

      {state.outcome?.kind === 'ok' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">{`  성공  ${state.steps.length}개 항목, ${duration(state.outcome.durationMs)}`}</Text>
          {state.backupId && (
            <Text dimColor>{`  되돌리기  claude-mv rollback ${state.backupId}`}</Text>
          )}
        </Box>
      )}

      {state.outcome?.kind === 'failed' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">{`  실패  ${state.outcome.message}`}</Text>
          <Text color={state.outcome.rolledBack ? 'green' : 'red'}>
            {state.outcome.rolledBack
              ? '  전부 원래대로 돌렸습니다. 바뀐 것은 없습니다.'
              : '  되돌리기도 실패했습니다. 손으로 복구해야 합니다.'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
