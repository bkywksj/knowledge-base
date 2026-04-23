---
layout: home
title: {{PROJECT_NAME}}
titleTemplate: false

hero:
  name: {{PROJECT_NAME}}
  text: {{PROJECT_TAGLINE}}
  tagline: {{PROJECT_DESC}}
  image:
    src: /logo.svg
    alt: {{PROJECT_NAME}}
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quickstart
    - theme: alt
      text: 项目介绍
      link: /guide/introduction

features:
  - icon: ⚡
    title: 高性能桌面体验
    details: 基于 Tauri 2.x + Rust 的原生性能，启动快、内存占用低、安装包小
  - icon: 🦀
    title: Rust 后端
    details: 内存安全 + 三层架构（Commands → Services → Database）分层清晰
  - icon: ⚛️
    title: React 19 前端
    details: TypeScript 5.8 + Ant Design + TailwindCSS，现代化企业级 UI
  - icon: 🔒
    title: 严格权限控制
    details: Tauri Capabilities 细粒度权限声明，默认最小权限原则
  - icon: 💾
    title: 本地 SQLite
    details: rusqlite 直接操作，WAL 模式 + 软删除 + Schema 迁移
  - icon: 📦
    title: 多平台打包
    details: 一键生成 Windows / macOS / Linux 安装包，支持代码签名和自动更新
---
