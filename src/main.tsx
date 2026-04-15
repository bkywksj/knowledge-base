import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadThemeFromStore } from "@/store";
import "./styles/global.css";

loadThemeFromStore().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
