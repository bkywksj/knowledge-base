import { useNavigate, useLocation } from "react-router-dom";
import { Menu, theme as antdTheme } from "antd";
import { Home, Info } from "lucide-react";
import { useAppStore } from "@/store";

const menuItems = [
  {
    key: "/",
    icon: <Home size={18} />,
    label: "首页",
  },
  {
    key: "/about",
    icon: <Info size={18} />,
    label: "关于",
  },
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const { token } = antdTheme.useToken();

  return (
    <div className="flex flex-col h-full">
      <div
        className="h-12 flex items-center justify-center font-bold text-base"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          color: token.colorText,
        }}
      >
        {collapsed ? "KB" : "Knowledge Base"}
      </div>
      <Menu
        mode="inline"
        selectedKeys={[location.pathname]}
        items={menuItems}
        onClick={({ key }) => navigate(key)}
        style={{ border: "none", flex: 1 }}
      />
    </div>
  );
}
