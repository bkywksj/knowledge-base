import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Input, List, Typography, Empty, Spin } from "antd";
import { Search as SearchIcon, FileText } from "lucide-react";
import { searchApi } from "@/lib/api";
import type { SearchResult } from "@/types";

const { Text } = Typography;

export default function SearchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const initializedRef = useRef(false);

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
          <List
            dataSource={results}
            renderItem={(item) => (
              <List.Item
                className="cursor-pointer"
                onClick={() => navigate(`/notes/${item.id}`)}
                style={{ padding: "12px 0" }}
              >
                <List.Item.Meta
                  avatar={<FileText size={20} style={{ marginTop: 4 }} />}
                  title={
                    <Text ellipsis style={{ maxWidth: 500 }}>
                      {item.title}
                    </Text>
                  }
                  description={
                    <div>
                      <div
                        style={{ fontSize: 13, marginBottom: 4 }}
                        dangerouslySetInnerHTML={{ __html: item.snippet }}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {item.updated_at.slice(0, 10)}
                      </Text>
                    </div>
                  }
                />
              </List.Item>
            )}
          />
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
