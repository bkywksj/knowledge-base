"""Android 旧版启动器图标（Android 7 及以下不认自适应图标）。

tauri icon 生成的 ic_launcher.png / ic_launcher_round.png 是从自适应前景图裁出来的，
书页被放得过大、圆形那张四周几乎全白 —— 这里改用满版图（iOS 那张 1024）按密度重切：
方形切 22% 圆角，圆形切正圆，覆盖生成结果。

用法：python legacy_launcher.py <tauri icon 的输出目录>
"""
import os
import sys

from PIL import Image, ImageDraw

out_dir = sys.argv[1]
src = Image.open(os.path.join(out_dir, "ios", "AppIcon-512@2x.png")).convert("RGBA")
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
SS = 4  # 超采样抗锯齿

for dpi, s in SIZES.items():
    big = src.resize((s * SS, s * SS), Image.LANCZOS)
    for name, circle in (("ic_launcher.png", False), ("ic_launcher_round.png", True)):
        mask = Image.new("L", big.size, 0)
        d = ImageDraw.Draw(mask)
        if circle:
            d.ellipse((0, 0, big.width - 1, big.height - 1), fill=255)
        else:
            d.rounded_rectangle((0, 0, big.width - 1, big.height - 1), radius=int(big.width * 0.22), fill=255)
        img = Image.new("RGBA", big.size, (0, 0, 0, 0))
        img.paste(big, (0, 0), mask)
        img.resize((s, s), Image.LANCZOS).save(os.path.join(out_dir, "android", f"mipmap-{dpi}", name))
print("ok")
