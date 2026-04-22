import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Input, Typography, Empty, Spin } from "antd";
import { Search as SearchIcon, FileText } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { searchApi } from "@/lib/api";
import type { SearchResult } from "@/types";

const { Text } = Typography;

/** 搜索结果单行高度估算（含 title + snippet + 日期三行 + 上下 padding） */
const ESTIMATED_ROW_HEIGHT = 92;

export default function SearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const initializedRef = useRef(false);
  // 虚拟滚动容器（仅在结果数较多时启用）
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
  });

  // 从 URL 参数 ?q= 初始化搜索
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const q = searchParams.get("q");
    if (q && q.trim()) {
      setQuery(q.trim());
      doSearch(q.trim());
    }
  }, [searchParams]);

  async function doSearch(keyword: string) {
    setLoading(true);
    setSearched(true);
    try {
      const data = await searchApi.search(keyword);
      setResults(data);
    } catch (e) {
      console.error("搜索失败:", e);
    } finally {
      setLoading(false);
    }
  }

  function handleInputChange(value: string) {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      doSearch(value.trim());
    }, 300);
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* 搜索框 */}
      <div className="mb-6">
        <Input.Search
          size="large"
          placeholder="输入搜索关键词..."
          prefix={<SearchIcon size={18} />}
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onSearch={(value) => handleInputChange(value)}
          allowClear
          enterButton="搜索"
          style={{ borderRadius: 8 }}
        />
      </div>

      {/* 搜索结果 */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" tip="搜索中..." />
        </div>
      ) : searched && results.length === 0 ? (
        <Empty
          description={`未找到与 "${query}" 相关的笔记`}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : results.length > 0 ? (
        <>
          <div className="mb-4">
            <Text type="secondary">
              找到 {results.length} 条结果
            </Text>
          </div>
          {/* 虚拟滚动：只渲染可见 + overscan 的结果行，千级结果也不卡 */}
          <div
            ref={scrollParentRef}
            style={{
              // 留出搜索框 + 结果计数 + 边距的空间，剩余区域做滚动容器
              height: "calc(100vh - 180px)",
              overflowY: "auto",
              contain: "strict",
            }}
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = results[vItem.index];
                return (
                  <div
                    key={item.id}
                    data-index={vItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                      padding: "12px 0",
                      borderBottom: "1px solid rgba(0,0,0,0.06)",
                      cursor: "pointer",
                      display: "flex",
                      gap: 12,
                    }}
                    onClick={() => navigate(`/notes/${item.id}`)}
                  >
                    <FileText size={20} style={{ marginTop: 4, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text ellipsis style={{ display: "block", maxWidth: 500, fontWeight: 500 }}>
                        {item.title}
                      </Text>
                      <div
                        style={{ fontSize: 13, marginTop: 4, marginBottom: 4 }}
                        dangerouslySetInnerHTML={{ __html: item.snippet }}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {item.updated_at.slice(0, 10)}
                      </Text>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : !searched ? (
        <div className="flex flex-col items-center py-12">
          <SearchIcon size={48} style={{ opacity: 0.15 }} />
          <Text type="secondary" className="mt-4" style={{ fontSize: 14 }}>
            输入关键词搜索笔记内容
          </Text>
        </div>
      ) : null}
    </div>
  );
}
