import { describe, it, expect } from "vitest";
import { isPortableConfigKey } from "./configShare";
import { describeBackup, needsRestart, pickBackup } from "./settingsBackup";
import { collectPortablePrefs } from "@/store";

describe("isPortableConfigKey · 导入端的写入闸", () => {
  it("名单内的行为设置、快捷键前缀、密钥键放行", () => {
    expect(isPortableConfigKey("window.close_action")).toBe(true);
    expect(isPortableConfigKey("shortcut.quick_capture")).toBe(true);
    expect(isPortableConfigKey("web_clip_jina_key")).toBe(true);
  });

  it("锁 / PIN 哈希、同步状态、本库 id 一律拒绝 —— 备份文件不能借导入改写它们", () => {
    for (const k of [
      "app_lock_hash",
      "hidden_pin_hash",
      "sync.backup_pw_enc",
      "sync.v0_last_push_notes",
      "mcp_http_token",
      "default_folder_id",
      "daily.default_template_id",
      "folder_watch_dir",
      "trash.auto_purge_since",
    ]) {
      expect(isPortableConfigKey(k), k).toBe(false);
    }
  });
});

describe("collectPortablePrefs", () => {
  it("带上主题和编辑器偏好，去掉本机 / 本库绑定的字段", () => {
    const prefs = collectPortablePrefs();
    expect(prefs).toHaveProperty("lightTheme");
    expect(prefs).toHaveProperty("editorFontSize");
    for (const k of ["sidePanelWidth", "uiScale", "recentSearches", "notesHeadingFolded", "customBgImage"]) {
      expect(prefs, k).not.toHaveProperty(k);
    }
  });
});

describe("describeBackup / pickBackup", () => {
  const data = {
    uiPrefs: { lightTheme: "light", editorFontSize: 16 },
    appConfig: { "window.close_action": "exit" },
    featureToggles: { enabledViews: ["daily"] },
    aiModels: [
      { name: "A", provider: "p", api_url: "u", api_key: null, model_id: "m" },
      { name: "B", provider: "p", api_url: "u", api_key: null, model_id: "m" },
    ],
    webdavBackends: [{ name: "旧 WebDAV", config: { url: "", username: "" } }],
    syncBackends: [{ kind: "s3" as const, name: "R2", config: {} }],
  };

  it("按分类汇总，老格式的 webdav 包 / 功能开关并进对应分类", () => {
    const items = describeBackup(data);
    expect(items.map((i) => i.key)).toEqual(["uiPrefs", "appConfig", "aiModels", "syncBackends"]);
    expect(items.find((i) => i.key === "appConfig")!.detail).toBe("2 项");
    expect(items.find((i) => i.key === "syncBackends")!.detail).toBe("2 个：旧 WebDAV、R2");
  });

  it("没勾的分类整块清掉，勾了的原样保留", () => {
    const picked = pickBackup(data, new Set(["aiModels", "syncBackends"]));
    expect(picked.uiPrefs).toBeUndefined();
    expect(picked.appConfig).toBeUndefined();
    expect(picked.featureToggles).toBeUndefined();
    expect(picked.aiModels).toHaveLength(2);
    expect(picked.webdavBackends).toHaveLength(1);
    expect(picked.syncBackends).toHaveLength(1);
  });

  it("空包没有可导入项", () => {
    expect(describeBackup({})).toEqual([]);
  });
});

describe("needsRestart", () => {
  it("含快捷键或最小化启动时提示重启", () => {
    expect(needsRestart({ appConfig: { "shortcut.quick_capture": "Ctrl+Alt+N" } })).toBe(true);
    expect(needsRestart({ appConfig: { start_minimized: "1" } })).toBe(true);
    expect(needsRestart({ appConfig: { "window.close_action": "exit" } })).toBe(false);
    expect(needsRestart({})).toBe(false);
  });
});
