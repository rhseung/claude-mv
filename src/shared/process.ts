import { execa } from 'execa';

import type { ProcessProbe } from '../core/lock.js';

/**
 * 프로세스 시작 시각을 구한다.
 *
 * ps-list 는 pid 존재와 이름만 주고 시작 시각은 주지 않는다. pid 재사용을 걸러내려면
 * 시작 시각이 꼭 필요해서 플랫폼별로 따로 묻는다.
 */
async function startedAt(pid: number, platform: NodeJS.Platform): Promise<number | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execa('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ]);
      const parsed = Date.parse(stdout.trim());
      return Number.isNaN(parsed) ? null : parsed;
    }

    // ps 는 로컬 시각을 준다. 레지스트리의 procStart 는 UTC 라 파싱 쪽에서 맞춰야 한다.
    const { stdout } = await execa('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function createProcessProbe(platform: NodeJS.Platform): ProcessProbe {
  return {
    async exists(pid) {
      try {
        // 시그널 0 은 아무 효과 없이 존재만 확인한다. EPERM 은 살아 있지만
        // 우리 것이 아니라는 뜻이므로 살아 있는 쪽으로 센다.
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    startedAt: (pid) => startedAt(pid, platform),
    self: process.pid,
  };
}
