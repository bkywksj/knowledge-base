#!/usr/bin/env python3
"""
R2 上传工具（Cloudflare R2 兼容 S3 API）。

用法：
    python r2-upload.py <本地文件> <R2目标路径>

示例：
    python r2-upload.py .tmp-versions-fixed.json knowledge-base/versions.json

凭证来源（优先级从高到低）：
    1. 环境变量 R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET
    2. ~/.config/knowledge-base/r2.env（KEY=VAL 格式）
"""
import os
import sys
from pathlib import Path

def load_env():
    cfg = Path.home() / ".config" / "knowledge-base" / "r2.env"
    if cfg.exists():
        for line in cfg.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    local_path, remote_key = sys.argv[1], sys.argv[2]
    if not Path(local_path).exists():
        print(f"❌ 本地文件不存在：{local_path}")
        sys.exit(1)

    load_env()
    account = os.environ.get("R2_ACCOUNT_ID")
    key_id = os.environ.get("R2_ACCESS_KEY")
    secret = os.environ.get("R2_SECRET_KEY")
    bucket = os.environ.get("R2_BUCKET", "downloads")
    if not all([account, key_id, secret]):
        print("❌ 缺少 R2 凭证（R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY）")
        sys.exit(1)

    import boto3
    from botocore.config import Config

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        config=Config(signature_version="s3v4", region_name="auto"),
    )

    size = Path(local_path).stat().st_size
    print(f"⬆  {local_path} ({size:,} bytes) → r2://{bucket}/{remote_key}")

    content_type = "application/json" if remote_key.endswith(".json") else "application/octet-stream"
    s3.upload_file(
        Filename=local_path,
        Bucket=bucket,
        Key=remote_key,
        ExtraArgs={"ContentType": content_type, "CacheControl": "no-cache"},
    )
    print(f"✅ 已上传：https://pub-9d9e6c0cb6934fb0a0c505e3c64f39b2.r2.dev/{remote_key}")

if __name__ == "__main__":
    main()
