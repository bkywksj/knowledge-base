import { useEffect } from "react";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useAppStore } from "@/store";
import { AppRouter } from "@/Router";
import { getAntdTokens } from "@/theme/tokens";

function App() {
  const themeCategory = useAppStore((s) => s.themeCategory);
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const activeTheme = themeCategory === "light" ? lightTheme : darkTheme;
  const tokens = getAntdTokens(activeTheme);

  // 同步主题到 DOM，供 CSS 选择器使用
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", activeTheme);
    document.documentElement.setAttribute("data-theme-category", themeCategory);
  }, [activeTheme, themeCategory]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm:
          themeCategory === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: tokens,
      }}
    >
      <ErrorBoundary>
        <AppRouter />
      </ErrorBoundary>
    </ConfigProvider>
  );
}

export default App;
