/**
 * DiffMergeModal 的懒加载外壳。
 *
 * 为什么要套一层：DiffMergeModal 是全项目唯一用到 CodeMirror（@codemirror/merge + view + state …）
 * 的地方，而三个调用方（对比剪贴板 / 对比笔记 / 两篇笔记对比）都挂在编辑器工具栏里、常驻渲染。
 * 直接静态导入会让每个打开笔记的人都下载整套 CodeMirror。
 *
 * 做法：首次 open 之前什么都不渲染；第一次打开才加载模块，之后保持挂载，
 * 这样关闭动画、二次打开都和原来一致。
 */
import { lazy, Suspense, useState, type ComponentProps } from "react";

const DiffMergeModalImpl = lazy(() =>
  import("./DiffMergeModal").then((m) => ({ default: m.DiffMergeModal })),
);

type Props = ComponentProps<typeof DiffMergeModalImpl>;

export function DiffMergeModal(props: Props) {
  const [everOpened, setEverOpened] = useState(props.open);
  // 渲染期同步翻转（React 允许的「根据 props 调整 state」写法），避免多一帧空白
  if (props.open && !everOpened) setEverOpened(true);
  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <DiffMergeModalImpl {...props} />
    </Suspense>
  );
}
