/**
 * 按文件类型渲染精致的彩色徽章图标
 *
 * 模仿 VS Code Material Icons 风格：
 * 圆角矩形 + 类型色填充/描边 + 居中字母标签
 */

interface Props {
  /** 源文件类型：pdf / docx / doc / md / markdown / null */
  type?: string | null;
  /** 像素尺寸（外接正方形边长），默认 16 */
  size?: number;
  /** 强制覆盖填充模式：solid=实心彩底白字；outline=浅色底彩字（默认） */
  variant?: "outline" | "solid";
}

interface IconConfig {
  label: string;
  color: string;
  bg: string;
}

function configFor(type: string | null | undefined): IconConfig {
  switch ((type ?? "").toLowerCase()) {
    case "pdf":
      return { label: "PDF", color: "#D4380D", bg: "#FFF1F0" };
    case "docx":
    case "doc":
      return { label: "W", color: "#1677FF", bg: "#E6F4FF" };
    case "md":
    case "markdown":
      return { label: "M↓", color: "#08979C", bg: "#E6FFFB" };
    default:
      return { label: "T", color: "#8C8C8C", bg: "#FAFAFA" };
  }
}

export function FileTypeIcon({ type, size = 16, variant = "outline" }: Props) {
  const cfg = configFor(type);
  const fontSize = cfg.label.length >= 3 ? 5 : cfg.label.length === 2 ? 6.5 : 8;

  const fillColor = variant === "solid" ? cfg.color : cfg.bg;
  const strokeColor = cfg.color;
  const textColor = variant === "solid" ? "#FFFFFF" : cfg.color;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }}
    >
      {/* 文件外形：略带圆角矩形 + 右上折角 */}
      <path
        d="M 2.5 1.5
           L 10.2 1.5
           L 13.5 4.8
           L 13.5 13.5
           Q 13.5 14.5 12.5 14.5
           L 3.5 14.5
           Q 2.5 14.5 2.5 13.5
           Z"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* 折角线 */}
      <path
        d="M 10.2 1.5 L 10.2 4.8 L 13.5 4.8"
        fill="none"
        stroke={strokeColor}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* 字母标签 */}
      <text
        x="8"
        y="11.5"
        textAnchor="middle"
        fontSize={fontSize}
        fontWeight="700"
        fill={textColor}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        letterSpacing={cfg.label.length >= 3 ? "-0.3" : "0"}
      >
        {cfg.label}
      </text>
    </svg>
  );
}
