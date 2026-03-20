import { Empty, Button } from "antd";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  description?: string;
  actionText?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon,
  description = "暂无数据",
  actionText,
  onAction,
}: EmptyStateProps) {
  return (
    <Empty
      image={icon || Empty.PRESENTED_IMAGE_SIMPLE}
      description={description}
    >
      {actionText && onAction && (
        <Button type="primary" onClick={onAction}>
          {actionText}
        </Button>
      )}
    </Empty>
  );
}
