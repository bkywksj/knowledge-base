import React from "react";
import ReactDOM from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import App from "./App";
import { loadThemeFromStore } from "@/store";
import "./styles/global.css";

// antd DatePicker 底层用 dayjs，默认英文；全局设成中文让月份 / 星期都本地化
dayjs.locale("zh-cn");

loadThemeFromStore().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
