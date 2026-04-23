import { defineConfig } from 'vitepress'

// ─── 站点基本信息（占位符由 /docs 初始化时替换）───
const SITE_NAME = '{{PROJECT_NAME}}'
const SITE_DESC = '{{PROJECT_DESC}}'
const SITE_URL = '{{SITE_URL}}'
const THEME_COLOR = '{{THEME_COLOR}}'

export default defineConfig({
  lang: 'zh-CN',
  title: SITE_NAME,
  description: SITE_DESC,

  head: [
    ['link', { rel: 'icon', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: THEME_COLOR }],
    ['meta', { name: 'keywords', content: '{{KEYWORDS}}' }],

    // ─── Open Graph ───
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:title', content: SITE_NAME }],
    ['meta', { property: 'og:description', content: SITE_DESC }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    ['meta', { property: 'og:site_name', content: SITE_NAME }],

    // ─── Twitter Card ───
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['meta', { name: 'twitter:title', content: SITE_NAME }],
    ['meta', { name: 'twitter:description', content: SITE_DESC }],

    // ─── JSON-LD ───
    ['script', { type: 'application/ld+json' }, JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESC,
      inLanguage: 'zh-CN',
    })],
  ],

  sitemap: {
    hostname: SITE_URL,
  },

  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: '指南', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: '前端', link: '/frontend/overview', activeMatch: '/frontend/' },
      { text: '后端', link: '/backend/architecture', activeMatch: '/backend/' },
      { text: 'API', link: '/api/commands', activeMatch: '/api/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '入门',
          items: [
            { text: '项目介绍', link: '/guide/introduction' },
            { text: '快速开始', link: '/guide/quickstart' },
            { text: '项目结构', link: '/guide/structure' },
          ],
        },
      ],
      '/frontend/': [
        {
          text: '前端开发',
          items: [
            { text: '概览', link: '/frontend/overview' },
          ],
        },
      ],
      '/backend/': [
        {
          text: '后端开发',
          items: [
            { text: '三层架构', link: '/backend/architecture' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API 参考',
          items: [
            { text: 'Commands', link: '/api/commands' },
          ],
        },
      ],
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    lastUpdated: { text: '最后更新', formatOptions: { dateStyle: 'short', timeStyle: 'short' } },

    socialLinks: [],
  },
})
