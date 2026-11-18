// lunar-javascript 不带类型声明，这里只声明用到的几个方法（见 src/lib/lunarLabel.ts）
declare module "lunar-javascript" {
  export interface Lunar {
    /** 农历月，如 "十"、"闰六"、"冬"、"腊" */
    getMonthInChinese(): string;
    /** 农历日，如 "初十"、"廿九" */
    getDayInChinese(): string;
    /** 当天的节气名，不是节气日返回空串 */
    getJieQi(): string;
    /** 农历传统节日，如 ["春节"] */
    getFestivals(): string[];
  }
  export interface Solar {
    getLunar(): Lunar;
    /** 公历节日，如 ["国庆节"] */
    getFestivals(): string[];
  }
  export const Solar: {
    fromDate(date: Date): Solar;
    fromYmd(year: number, month: number, day: number): Solar;
  };
}
