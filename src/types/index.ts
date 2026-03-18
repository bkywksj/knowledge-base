/** 应用配置 */
export interface AppConfig {
  key: string;
  value: string;
}

/** 系统信息 */
export interface SystemInfo {
  os: string;
  arch: string;
  appVersion: string;
  dataDir: string;
}
