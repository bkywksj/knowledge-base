//! 本地路径 backend：把 vault 写到用户磁盘上的某个目录
//!
//! 用户场景：
//! - 把目录设到自己的同步盘（百度网盘/夸克/iCloud Drive/OneDrive 文件夹）
//! - 这样就借用了云盘自己的同步能力，不需要本应用集成 SDK
//! - 缺点：云盘服务商能看到明文 .md 内容（无加密）
//!
//! 实现要点：
//! - 所有 `.md` 写到 `<root>/notes/<stable_id>.md`
//! - manifest 写到 `<root>/manifest.json`
//! - 写入用 `tempfile + rename` 保证原子性，避免 .md 写到一半被同步盘上传

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::models::SyncManifestV1;

use super::backend::{SyncBackendImpl, MANIFEST_FILENAME};

pub struct LocalPathBackend {
    root: PathBuf,
}

impl LocalPathBackend {
    pub fn new(root: &str) -> Self {
        Self {
            root: PathBuf::from(root),
        }
    }

    /// 把 backend 内"posix 风格相对路径"映射到本地真实路径
    fn resolve(&self, posix_path: &str) -> PathBuf {
        // 把 / 转成系统分隔符；防止 .. 越界（v1 不严格做沙箱，依赖用户自己选合理目录）
        let mut p = self.root.clone();
        for seg in posix_path.split('/') {
            if seg.is_empty() || seg == "." || seg == ".." {
                continue;
            }
            p.push(seg);
        }
        p
    }

    fn ensure_dir(path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// 原子写：先写 .tmp，再 rename
    fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        Self::ensure_dir(path)?;
        let tmp = path.with_extension(format!(
            "{}.tmp",
            path.extension().and_then(|s| s.to_str()).unwrap_or("")
        ));
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all().ok(); // 尽力 fsync；某些 FS（如部分网盘虚拟盘）不支持，忽略错误
        }
        // Windows 上 rename 到已存在文件会失败，先删
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

impl SyncBackendImpl for LocalPathBackend {
    fn name(&self) -> &'static str {
        "local"
    }

    fn test_connection(&self) -> Result<(), AppError> {
        // 测试 = 创建根目录 + 写一个 .test 探针 + 删
        fs::create_dir_all(&self.root)?;
        let probe = self.root.join(".kb_sync_test");
        fs::write(&probe, b"ok")?;
        fs::remove_file(&probe)?;
        Ok(())
    }

    fn read_manifest(&self) -> Result<Option<SyncManifestV1>, AppError> {
        let path = self.resolve(MANIFEST_FILENAME);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path)?;
        let m: SyncManifestV1 = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::Custom(format!("远端 manifest 解析失败: {}", e)))?;
        Ok(Some(m))
    }

    fn write_manifest(&self, manifest: &SyncManifestV1) -> Result<(), AppError> {
        let path = self.resolve(MANIFEST_FILENAME);
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|e| AppError::Custom(format!("manifest 序列化失败: {}", e)))?;
        Self::atomic_write(&path, &bytes)
    }

    fn put_note(&self, path: &str, content: &str) -> Result<(), AppError> {
        let p = self.resolve(path);
        Self::atomic_write(&p, content.as_bytes())
    }

    fn get_note(&self, path: &str) -> Result<Option<String>, AppError> {
        let p = self.resolve(path);
        if !p.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&p)?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn delete_note(&self, path: &str) -> Result<(), AppError> {
        let p = self.resolve(path);
        if p.exists() {
            fs::remove_file(&p)?;
        }
        Ok(())
    }

    fn put_attachment(&self, hash: &str, bytes: &[u8]) -> Result<(), AppError> {
        let rel = super::backend::cas_path(hash);
        let p = self.resolve(&rel);
        // 幂等：相同 hash 重复上传无副作用（覆盖即可）
        Self::atomic_write(&p, bytes)
    }

    fn get_attachment(&self, hash: &str) -> Result<Option<Vec<u8>>, AppError> {
        let rel = super::backend::cas_path(hash);
        let p = self.resolve(&rel);
        if !p.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(&p)?))
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, AppError> {
        let rel = super::backend::cas_path(hash);
        Ok(self.resolve(&rel).exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ManifestEntry, SyncManifestV1};

    #[test]
    fn local_backend_roundtrip() {
        let dir = std::env::temp_dir().join("kb_sync_v1_local_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let backend = LocalPathBackend::new(dir.to_str().unwrap());
        backend.test_connection().unwrap();

        // manifest 往返
        let m = SyncManifestV1 {
            manifest_version: SyncManifestV1::VERSION,
            app_version: "1.2.0-test".into(),
            device: "test-host".into(),
            generated_at: "2026-04-25 12:00:00".into(),
            entries: vec![ManifestEntry {
                stable_id: "1".into(),
                title: "test 笔记".into(),
                content_hash: "abcd".into(),
                updated_at: "2026-04-25 12:00:00".into(),
                remote_path: "notes/1.md".into(),
                tombstone: false,
                folder_path: "工作/周报".into(),
                encrypted: false,
            }],
            hash_algo: Some(SyncManifestV1::HASH_ALGO_V2.into()),
            vault: None,
            attachments: vec![],
        };
        backend.write_manifest(&m).unwrap();
        let got = backend.read_manifest().unwrap().expect("应能读回 manifest");
        assert_eq!(got.entries.len(), 1);
        assert_eq!(got.entries[0].title, "test 笔记");
        assert_eq!(got.entries[0].folder_path, "工作/周报");

        // 笔记往返
        backend.put_note("notes/1.md", "# Hello\n\nbody").unwrap();
        let body = backend.get_note("notes/1.md").unwrap();
        assert_eq!(body.as_deref(), Some("# Hello\n\nbody"));

        // 不存在的笔记
        assert!(backend.get_note("notes/missing.md").unwrap().is_none());

        // 删除
        backend.delete_note("notes/1.md").unwrap();
        assert!(backend.get_note("notes/1.md").unwrap().is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// T-S023：附件 CAS 路径布局往返 put/get/has
    #[test]
    fn local_backend_attachment_cas_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "kb-sync-attach-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let backend = LocalPathBackend::new(dir.to_str().unwrap());
        backend.test_connection().unwrap();

        let hash = "abcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
        let bytes: Vec<u8> = vec![1, 2, 3, 4, 0xff];

        // has = false before put
        assert!(!backend.has_attachment(hash).unwrap());
        assert!(backend.get_attachment(hash).unwrap().is_none());

        // put then check
        backend.put_attachment(hash, &bytes).unwrap();
        assert!(backend.has_attachment(hash).unwrap());

        // CAS 路径形状：attachments/ab/cd/<full hash>
        let expected_rel = format!("attachments/ab/cd/{}", hash);
        let abs = dir.join(&expected_rel);
        assert!(abs.exists(), "应落到 CAS 分桶路径; got = {}", abs.display());

        // get 内容字节级一致
        let got = backend.get_attachment(hash).unwrap().expect("应能拿到");
        assert_eq!(got, bytes);

        // 幂等：同 hash 重复 put 不报错
        backend.put_attachment(hash, &bytes).unwrap();
        assert_eq!(backend.get_attachment(hash).unwrap().unwrap(), bytes);

        let _ = fs::remove_dir_all(&dir);
    }

    /// T-S023：cas_path 路径分桶正确性
    #[test]
    fn cas_path_layout() {
        use super::super::backend::cas_path;
        assert_eq!(
            cas_path("abcdef1234"),
            "attachments/ab/cd/abcdef1234"
        );
        // 短 hash 防御性兜底
        assert_eq!(cas_path("xy"), "attachments/_/_/xy");
        assert_eq!(cas_path(""), "attachments/_/_/");
    }

    /// T-S030：trait 默认 batch_put_notes 实现（串行调 put_note，本地 backend 没 override）
    #[test]
    fn batch_put_notes_default_serial_works() {
        let dir = std::env::temp_dir().join(format!(
            "kb-sync-batch-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let backend = LocalPathBackend::new(dir.to_str().unwrap());
        backend.test_connection().unwrap();

        let items: Vec<(String, String)> = vec![
            ("notes/a.md".into(), "# A\nbody a".into()),
            ("notes/b.md".into(), "# B\nbody b".into()),
            ("notes/c.md".into(), "# C\nbody c".into()),
        ];

        let results = backend.batch_put_notes(&items);
        assert_eq!(results.len(), 3, "结果数与入参一一对应");
        assert!(results.iter().all(|r| r.is_ok()), "全部应成功: {:?}", results);

        // 验证三条都能读回
        for (path, body) in &items {
            let got = backend.get_note(path).unwrap().expect("应能读回");
            assert_eq!(&got, body);
        }

        // 空数组
        let empty = backend.batch_put_notes(&[]);
        assert!(empty.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
