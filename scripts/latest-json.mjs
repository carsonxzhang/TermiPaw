// 更新器读取的 latest.json。发布脚本和端到端测试共用，测试才能证明发布的格式程序真的认。

/** 发布文件的名字，每个版本都一样。程序更新时要求签名里记着的就是这个名字（src-tauri/src/selfupdate.rs） */
export const RELEASE_FILE_NAME = "TermiPaw.exe";

export function latestJson({ version, notes, url, signature, date = new Date() }) {
  return {
    version,
    notes,
    pub_date: date.toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: {
      "windows-x86_64": { signature, url },
    },
  };
}
