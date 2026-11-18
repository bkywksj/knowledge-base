import { lanSyncApi, syncV1Api } from "@/lib/api";
import type { SyncBackend } from "@/types";

/**
 * 手机端页面用的同步源列表：去掉「局域网同步（本机中转）」。
 *
 * 那是本机「当主机」时内部用的中转库（services::lan_sync），不是用户配的同步源，
 * 出现在同步页、首页 / 我的页同步卡上只会让人困惑。电脑端设置页照常显示它（那边是有意让用户看到的）。
 */
export async function listUserSyncBackends(): Promise<SyncBackend[]> {
  const [list, lan] = await Promise.all([syncV1Api.listBackends(), lanSyncApi.status().catch(() => null)]);
  return lan?.backendId != null ? list.filter((b) => b.id !== lan.backendId) : list;
}
