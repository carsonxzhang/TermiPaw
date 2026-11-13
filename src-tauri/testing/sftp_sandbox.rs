//! 被限制在本地目录内的 SFTP 服务端，供 `dev_server` 示例和单元测试共用。
//!
//! 行为按 OpenSSH 的 sftp-server 实现：改名时目标已存在会失败。
//! 测试可以通过 [`Faults`] 注入故障，模拟权限不足、传输中断等情况。

#![allow(dead_code)] // 两边各自只用到其中一部分

use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};

use russh_sftp::protocol::{Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version};

/// 将虚拟绝对路径规范化（处理 `.` / `..`），结果总是以 `/` 开头
pub fn normalize(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') { path.to_string() } else { format!("{base}/{path}") };
    let mut parts: Vec<&str> = Vec::new();
    for c in Path::new(&joined).components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str().unwrap_or("")),
            Component::ParentDir => {
                parts.pop();
            }
            _ => {}
        }
    }
    format!("/{}", parts.join("/"))
}

pub fn real(root: &Path, home: &str, vpath: &str) -> PathBuf {
    root.join(normalize(home, vpath).trim_start_matches('/'))
}

fn io_status(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn ok(id: u32) -> Status {
    Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en-US".into() }
}

/// 测试用的故障开关和模拟状态，键均为虚拟路径
#[derive(Default)]
pub struct Faults {
    /// 拒绝以写方式打开文件（模拟文件只读或目录不可写）
    pub deny_open_for_write: bool,
    /// 写入数据时失败
    pub fail_writes: bool,
    /// 读取数据时失败
    pub fail_reads: bool,
    /// 拒绝来源路径包含该字符串的改名
    pub deny_rename_from_containing: Option<String>,
    /// 模拟的文件权限，磁盘上的权限在 Windows 上无法表示
    pub modes: HashMap<String, u32>,
    /// 模拟的符号链接：链接路径 -> 目标路径
    pub links: HashMap<String, String>,
    /// 每次写入前等待一会儿，让传输慢下来
    pub write_delay: Option<Duration>,
    /// 列目录时额外返回的条目（目录的虚拟路径 -> 名字和是否目录），模拟恶意服务器给出的文件名
    pub fake_entries: HashMap<String, Vec<(String, bool)>>,
}

enum OpenHandle {
    File(fs::File),
    Dir(Option<Vec<File>>),
}

pub struct SandboxSftp {
    root: PathBuf,
    home: String,
    handles: HashMap<String, OpenHandle>,
    next: u64,
    faults: Arc<Mutex<Faults>>,
}

impl SandboxSftp {
    pub fn new(root: PathBuf, home: &str, faults: Arc<Mutex<Faults>>) -> Self {
        Self { root, home: home.to_string(), handles: HashMap::new(), next: 0, faults }
    }

    fn add(&mut self, h: OpenHandle) -> String {
        self.next += 1;
        let id = self.next.to_string();
        self.handles.insert(id.clone(), h);
        id
    }

    fn vpath(&self, path: &str) -> String {
        normalize(&self.home, path)
    }

    /// 跟随模拟的符号链接
    fn follow(&self, path: &str) -> String {
        let v = self.vpath(path);
        self.faults.lock().unwrap().links.get(&v).cloned().unwrap_or(v)
    }

    fn real(&self, vpath: &str) -> PathBuf {
        real(&self.root, &self.home, vpath)
    }

    fn attrs_of(&self, vpath: &str, meta: &fs::Metadata) -> FileAttributes {
        let default_mode = if meta.is_dir() {
            0o040755
        } else if meta.permissions().readonly() {
            0o100444
        } else {
            0o100644
        };
        let mode = self.faults.lock().unwrap().modes.get(vpath).copied().unwrap_or(default_mode);
        FileAttributes {
            size: Some(meta.len()),
            permissions: Some(mode),
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as u32),
            ..Default::default()
        }
    }
}

impl russh_sftp::server::Handler for SandboxSftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _version: u32, _ext: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name { id, files: vec![File::dummy(self.follow(&path))] })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let v = self.follow(&path);
        let meta = fs::metadata(self.real(&v)).map_err(io_status)?;
        Ok(Attrs { id, attrs: self.attrs_of(&v, &meta) })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let v = self.vpath(&path);
        if self.faults.lock().unwrap().links.contains_key(&v) {
            let attrs = FileAttributes { size: Some(0), permissions: Some(0o120777), ..Default::default() };
            return Ok(Attrs { id, attrs });
        }
        self.stat(id, path).await
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        match self.handles.get(&handle) {
            Some(OpenHandle::File(f)) => {
                let meta = f.metadata().map_err(io_status)?;
                let attrs = FileAttributes { size: Some(meta.len()), permissions: Some(0o100644), ..Default::default() };
                Ok(Attrs { id, attrs })
            }
            _ => Err(StatusCode::Failure),
        }
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let dir = self.vpath(&path);
        let mut files = Vec::new();
        for e in fs::read_dir(self.real(&dir)).map_err(io_status)?.flatten() {
            if let Ok(meta) = e.metadata() {
                let name = e.file_name().to_string_lossy().into_owned();
                let attrs = self.attrs_of(&normalize(&dir, &name), &meta);
                files.push(File::new(name, attrs));
            }
        }
        let faults = self.faults.lock().unwrap();
        if let Some(fake) = faults.fake_entries.get(&dir) {
            for (name, is_dir) in fake {
                let is_link = faults.links.contains_key(&normalize(&dir, name));
                let mode = if is_link { 0o120777 } else if *is_dir { 0o040755 } else { 0o100644 };
                files.push(File::new(name.clone(), FileAttributes { size: Some(1), permissions: Some(mode), ..Default::default() }));
            }
        }
        drop(faults);
        Ok(Handle { id, handle: self.add(OpenHandle::Dir(Some(files))) })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.handles.get_mut(&handle) {
            Some(OpenHandle::Dir(files)) => match files.take() {
                Some(files) if !files.is_empty() => Ok(Name { id, files }),
                _ => Err(StatusCode::Eof),
            },
            _ => Err(StatusCode::Failure),
        }
    }

    async fn open(&mut self, id: u32, filename: String, flags: OpenFlags, _attrs: FileAttributes) -> Result<Handle, Self::Error> {
        let wants_write = flags.contains(OpenFlags::WRITE) || flags.contains(OpenFlags::APPEND);
        if wants_write && self.faults.lock().unwrap().deny_open_for_write {
            return Err(StatusCode::PermissionDenied);
        }
        let v = self.follow(&filename);
        let file = fs::OpenOptions::new()
            .read(flags.contains(OpenFlags::READ))
            .write(wants_write)
            .append(flags.contains(OpenFlags::APPEND))
            .create(flags.contains(OpenFlags::CREATE))
            .truncate(flags.contains(OpenFlags::TRUNCATE))
            .open(self.real(&v))
            .map_err(io_status)?;
        Ok(Handle { id, handle: self.add(OpenHandle::File(file)) })
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        if self.faults.lock().unwrap().fail_reads {
            return Err(StatusCode::Failure);
        }
        let Some(OpenHandle::File(f)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
        f.seek(SeekFrom::Start(offset)).map_err(io_status)?;
        let mut buf = vec![0; len as usize];
        let n = f.read(&mut buf).map_err(io_status)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        let (fail, delay) = {
            let faults = self.faults.lock().unwrap();
            (faults.fail_writes, faults.write_delay)
        };
        if fail {
            return Err(StatusCode::Failure);
        }
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        let Some(OpenHandle::File(f)) = self.handles.get_mut(&handle) else { return Err(StatusCode::Failure) };
        f.seek(SeekFrom::Start(offset)).map_err(io_status)?;
        f.write_all(&data).map_err(io_status)?;
        Ok(ok(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(ok(id))
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        fs::create_dir(self.real(&path)).map_err(io_status)?;
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        fs::remove_dir(self.real(&path)).map_err(io_status)?;
        Ok(ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        fs::remove_file(self.real(&filename)).map_err(io_status)?;
        let v = self.vpath(&filename);
        self.faults.lock().unwrap().modes.remove(&v);
        Ok(ok(id))
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        if let Some(pattern) = &self.faults.lock().unwrap().deny_rename_from_containing {
            if oldpath.contains(pattern) {
                return Err(StatusCode::PermissionDenied);
            }
        }
        let (from, to) = (self.vpath(&oldpath), self.vpath(&newpath));
        // 与 OpenSSH 一致：目标已存在时失败，而不是覆盖
        if self.real(&to).exists() {
            return Err(StatusCode::Failure);
        }
        fs::rename(self.real(&from), self.real(&to)).map_err(io_status)?;
        let mut faults = self.faults.lock().unwrap();
        if let Some(mode) = faults.modes.remove(&from) {
            faults.modes.insert(to, mode);
        }
        Ok(ok(id))
    }

    async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        if let Some(mode) = attrs.permissions {
            let v = self.vpath(&path);
            self.faults.lock().unwrap().modes.insert(v, mode);
        }
        Ok(ok(id))
    }
}
