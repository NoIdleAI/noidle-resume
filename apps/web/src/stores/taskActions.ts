import { ref } from 'vue';
import { api, ApiError } from '../api/client';
import { humanizeError } from '../api/humanize';
import { refreshSessions, refreshTasks, refreshLogs } from './data';

/** 任务动作（暂停/取消/重试）共享柄：busy + 错误人话透出。 */
export function useTaskActions() {
  const busyId = ref<string | null>(null);
  const error = ref('');

  async function run(id: string, kind: 'pause' | 'cancel' | 'retry'): Promise<boolean> {
    if (busyId.value !== null) return false;
    busyId.value = id;
    error.value = '';
    try {
      if (kind === 'pause') await api.pauseTask(id);
      else if (kind === 'cancel') await api.cancelTask(id);
      else await api.retryTask(id);
      // WS 会推 task.changed；这里主动补拉保证列表/会话行即时一致
      await Promise.all([refreshTasks(), refreshSessions(), refreshLogs()]);
      return true;
    } catch (err) {
      if (err instanceof ApiError) error.value = humanizeError(err.code, err.message);
      else error.value = '操作失败：服务不可达';
      return false;
    } finally {
      busyId.value = null;
    }
  }

  return { busyId, error, run };
}
