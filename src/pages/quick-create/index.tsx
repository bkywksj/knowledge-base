import { useNavigate } from "react-router-dom";
import { MNavBar } from "@/components/mobile/primitives";
import { QuickCreatePanel } from "@/components/mobile/QuickCreate";

/**
 * 移动端「新建」整页（路由 /quick-create，仅移动端用）。
 *
 * 平时由 FAB 直接在当前页弹出底部面板（components/mobile/QuickCreate 的 QuickCreateSheet），
 * 这个整页留给深链入口（「我的 → 导入笔记」等），内容与面板是同一个 QuickCreatePanel。
 * 跳编辑器用 replace：返回时回到进来之前的页面，而不是又回到新建页。
 */
export default function QuickCreatePage() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto w-full max-w-[860px] pb-8">
      <MNavBar onBack={() => navigate(-1)} />
      <QuickCreatePanel replaceOnNavigate />
    </div>
  );
}
