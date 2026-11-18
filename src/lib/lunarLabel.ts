/**
 * 首页日期旁的农历小字（用户反馈：希望看到农历 / 节日）。
 *
 * 优先级：节日（公历 + 农历传统节日）> 节气 > 农历日期（「十月初十」）。
 * 不做法定假日 / 调休：每年国务院公布才知道，要年年更新数据，做错了反而误导。
 *
 * lunar-javascript 体积不小（~500KB 未压缩），用动态 import 拆成单独的包，首页第一次用到才加载，不拖慢启动。
 */
export async function lunarLabel(date: Date): Promise<string> {
  const { Solar } = await import("lunar-javascript");
  return lunarLabelOf(Solar.fromDate(date));
}

/** 纯函数部分，便于单测 */
export function lunarLabelOf(solar: import("lunar-javascript").Solar): string {
  const lunar = solar.getLunar();
  const festival = solar.getFestivals()[0] ?? lunar.getFestivals()[0];
  if (festival) return festival;
  const term = lunar.getJieQi();
  if (term) return term;
  return `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
}
