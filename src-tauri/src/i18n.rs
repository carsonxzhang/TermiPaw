//! 给用户看的文字。后端不拼任何语言的句子，只给出代码和参数，由界面按当前语言翻译，
//! 译文都在 `src/i18n/` 里（见 docs/I18N.md）。
//!
//! 只有两样由后端自己处理：系统文件对话框的标题（对话框是后端弹出的），
//! 以及重置保险库的确认词（必须由后端核对，界面不能替用户跳过）。

use std::{
    collections::BTreeMap,
    fmt,
    sync::atomic::{AtomicU8, Ordering},
};

use serde::Serialize;

/// 一句给用户看的话
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Text {
    pub code: &'static str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub args: BTreeMap<&'static str, Arg>,
}

/// 参数：原样显示的内容（文件名、服务器返回的错误）、数字（界面用来选单复数）、
/// 一组名字（界面按语言的习惯连接），或者另一句要翻译的话
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Arg {
    Raw(String),
    Num(u64),
    List(Vec<String>),
    Text(Text),
}

/// 新建一句话
pub fn t(code: &'static str) -> Text {
    Text { code, args: BTreeMap::new() }
}

impl Text {
    pub fn arg(mut self, name: &'static str, value: impl Into<Arg>) -> Self {
        self.args.insert(name, value.into());
        self
    }

    /// 原样显示的错误说明，通常来自服务器、系统或依赖库
    pub fn detail(self, error: impl fmt::Display) -> Self {
        self.arg("detail", error.to_string())
    }
}

/// 只用于日志和测试里的断言，用户看到的是界面翻译后的文字
impl fmt::Display for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code)?;
        if !self.args.is_empty() {
            let args: Vec<String> = self.args.iter().map(|(k, v)| format!("{k}={v}")).collect();
            write!(f, "({})", args.join(", "))?;
        }
        Ok(())
    }
}

impl fmt::Display for Arg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Raw(s) => f.write_str(s),
            Self::Num(n) => write!(f, "{n}"),
            Self::List(items) => f.write_str(&items.join(", ")),
            Self::Text(t) => write!(f, "{t}"),
        }
    }
}

impl From<String> for Arg {
    fn from(s: String) -> Self {
        Self::Raw(s)
    }
}

impl From<&str> for Arg {
    fn from(s: &str) -> Self {
        Self::Raw(s.to_owned())
    }
}

impl From<Text> for Arg {
    fn from(t: Text) -> Self {
        Self::Text(t)
    }
}

impl From<Vec<String>> for Arg {
    fn from(items: Vec<String>) -> Self {
        Self::List(items)
    }
}

macro_rules! num_arg {
    ($($t:ty),*) => {
        $(impl From<$t> for Arg {
            fn from(n: $t) -> Self {
                Self::Num(n as u64)
            }
        })*
    };
}
num_arg!(u16, u32, u64, usize);

// ---------- 当前语言 ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Lang {
    En,
    ZhCn,
    ZhTw,
    Ja,
    Ko,
    Fr,
    Es,
    De,
}

impl Lang {
    const ALL: [Lang; 8] = [Lang::En, Lang::ZhCn, Lang::ZhTw, Lang::Ja, Lang::Ko, Lang::Fr, Lang::Es, Lang::De];

    fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::ZhCn => "zh-CN",
            Lang::ZhTw => "zh-TW",
            Lang::Ja => "ja",
            Lang::Ko => "ko",
            Lang::Fr => "fr",
            Lang::Es => "es",
            Lang::De => "de",
        }
    }

    fn parse(code: &str) -> Option<Lang> {
        Self::ALL.into_iter().find(|l| l.code() == code)
    }
}

/// 界面启动前用英文。界面一启动就会告诉后端真正的语言
static CURRENT: AtomicU8 = AtomicU8::new(Lang::En as u8);

pub fn current() -> Lang {
    let n = CURRENT.load(Ordering::Relaxed);
    Lang::ALL.into_iter().find(|l| *l as u8 == n).unwrap_or(Lang::En)
}

/// 界面启动时和用户切换语言时调用。不认识的语言当作英文
#[tauri::command]
pub fn set_language(lang: String) {
    CURRENT.store(Lang::parse(&lang).unwrap_or(Lang::En) as u8, Ordering::Relaxed);
}

// ---------- 由后端自己显示的文字 ----------

#[derive(Clone, Copy)]
pub enum Dialog {
    UploadFiles,
    UploadFolder,
    DownloadTo,
    SaveTo,
    KeyFile,
    Editor,
}

/// 系统文件对话框的标题
pub fn dialog_title(dialog: Dialog) -> &'static str {
    use Dialog::*;
    use Lang::*;
    match (current(), dialog) {
        (En, UploadFiles) => "Choose files to upload",
        (En, UploadFolder) => "Choose a folder to upload",
        (En, DownloadTo) => "Download to",
        (En, SaveTo) => "Save to",
        (En, KeyFile) => "Choose a private key file",
        (En, Editor) => "Choose the program for opening remote files",

        (ZhCn, UploadFiles) => "选择要上传的文件",
        (ZhCn, UploadFolder) => "选择要上传的文件夹",
        (ZhCn, DownloadTo) => "下载到",
        (ZhCn, SaveTo) => "保存到",
        (ZhCn, KeyFile) => "选择私钥文件",
        (ZhCn, Editor) => "选择用来打开远程文件的程序",

        (ZhTw, UploadFiles) => "選擇要上傳的檔案",
        (ZhTw, UploadFolder) => "選擇要上傳的資料夾",
        (ZhTw, DownloadTo) => "下載到",
        (ZhTw, SaveTo) => "儲存到",
        (ZhTw, KeyFile) => "選擇私鑰檔案",
        (ZhTw, Editor) => "選擇用來開啟遠端檔案的程式",

        (Ja, UploadFiles) => "アップロードするファイルを選択",
        (Ja, UploadFolder) => "アップロードするフォルダーを選択",
        (Ja, DownloadTo) => "ダウンロード先",
        (Ja, SaveTo) => "保存先",
        (Ja, KeyFile) => "秘密鍵ファイルを選択",
        (Ja, Editor) => "リモートファイルを開くプログラムを選択",

        (Ko, UploadFiles) => "업로드할 파일 선택",
        (Ko, UploadFolder) => "업로드할 폴더 선택",
        (Ko, DownloadTo) => "다운로드 위치",
        (Ko, SaveTo) => "저장 위치",
        (Ko, KeyFile) => "개인 키 파일 선택",
        (Ko, Editor) => "원격 파일을 열 프로그램 선택",

        (Fr, UploadFiles) => "Choisir les fichiers à téléverser",
        (Fr, UploadFolder) => "Choisir un dossier à téléverser",
        (Fr, DownloadTo) => "Télécharger dans",
        (Fr, SaveTo) => "Enregistrer dans",
        (Fr, KeyFile) => "Choisir un fichier de clé privée",
        (Fr, Editor) => "Choisir le programme pour ouvrir les fichiers distants",

        (Es, UploadFiles) => "Elegir archivos para subir",
        (Es, UploadFolder) => "Elegir una carpeta para subir",
        (Es, DownloadTo) => "Descargar en",
        (Es, SaveTo) => "Guardar en",
        (Es, KeyFile) => "Elegir un archivo de clave privada",
        (Es, Editor) => "Elegir el programa para abrir archivos remotos",

        (De, UploadFiles) => "Dateien zum Hochladen auswählen",
        (De, UploadFolder) => "Ordner zum Hochladen auswählen",
        (De, DownloadTo) => "Herunterladen nach",
        (De, SaveTo) => "Speichern unter",
        (De, KeyFile) => "Private Schlüsseldatei auswählen",
        (De, Editor) => "Programm zum Öffnen entfernter Dateien auswählen",
    }
}

/// 文件对话框里“程序（*.exe）”这一类文件的名字
pub fn programs_filter() -> &'static str {
    match current() {
        Lang::En => "Programs",
        Lang::ZhCn => "程序",
        Lang::ZhTw => "程式",
        Lang::Ja => "プログラム",
        Lang::Ko => "프로그램",
        Lang::Fr => "Programmes",
        Lang::Es => "Programas",
        Lang::De => "Programme",
    }
}

// ---------- 启动时的提示 ----------

/// 系统（用户默认区域）的语言。启动时窗口还没有，界面也还没告诉后端用什么语言
#[cfg(windows)]
pub fn system_language() -> Lang {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    // LOCALE_NAME_MAX_LENGTH
    let mut buffer = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if len <= 1 {
        return Lang::En;
    }
    lang_from_tag(&String::from_utf16_lossy(&buffer[..len as usize - 1]))
}

#[cfg(not(windows))]
pub fn system_language() -> Lang {
    Lang::En
}

/// `zh-TW`、`ja-JP` 这类语言标签对应的语言，不认识的用英文。规则和界面里的 `detect.ts` 一致
fn lang_from_tag(tag: &str) -> Lang {
    let tag = tag.to_ascii_lowercase();
    if tag == "zh" || tag.starts_with("zh-") {
        let traditional = !tag.starts_with("zh-hans") && ["zh-hant", "zh-tw", "zh-hk", "zh-mo"].iter().any(|p| tag.starts_with(p));
        return if traditional { Lang::ZhTw } else { Lang::ZhCn };
    }
    [Lang::Ja, Lang::Ko, Lang::Fr, Lang::Es, Lang::De]
        .into_iter()
        .find(|l| tag == l.code() || tag.starts_with(&format!("{}-", l.code())))
        .unwrap_or(Lang::En)
}

/// 数据目录用不了时，对话框里的说明
pub fn startup_error(lang: Lang, dir: &str, reason: &str) -> String {
    let (head, tail) = match lang {
        Lang::En => ("TermiPaw can't write to its data folder:", "Move TermiPaw.exe to a folder you can write to, such as the desktop or a USB drive, and start it again."),
        Lang::ZhCn => ("TermiPaw 无法写入它的数据文件夹：", "请把 TermiPaw.exe 移到可以写入的文件夹里（比如桌面或 U 盘），再重新打开。"),
        Lang::ZhTw => ("TermiPaw 無法寫入它的資料資料夾：", "請把 TermiPaw.exe 移到可以寫入的資料夾裡（例如桌面或 USB 隨身碟），再重新開啟。"),
        Lang::Ja => ("TermiPaw はデータフォルダーに書き込めません：", "TermiPaw.exe をデスクトップや USB メモリなど、書き込めるフォルダーに移してから、もう一度起動してください。"),
        Lang::Ko => ("TermiPaw가 데이터 폴더에 쓸 수 없습니다:", "TermiPaw.exe를 바탕 화면이나 USB 드라이브처럼 쓸 수 있는 폴더로 옮긴 뒤 다시 실행하세요."),
        Lang::Fr => ("TermiPaw ne peut pas écrire dans son dossier de données :", "Déplacez TermiPaw.exe dans un dossier où vous pouvez écrire, comme le bureau ou une clé USB, puis relancez-le."),
        Lang::Es => ("TermiPaw no puede escribir en su carpeta de datos:", "Mueve TermiPaw.exe a una carpeta donde puedas escribir, como el escritorio o una unidad USB, y vuelve a abrirlo."),
        Lang::De => ("TermiPaw kann nicht in seinen Datenordner schreiben:", "Verschiebe TermiPaw.exe in einen Ordner, in den du schreiben darfst, etwa den Desktop oder einen USB-Stick, und starte es erneut."),
    };
    format!("{head}\n{dir}\n\n{reason}\n\n{tail}")
}

/// 重置保险库时要用户输入的词。界面显示的词要和这里一致，`src/i18n/` 的测试会核对
pub fn reset_word() -> &'static str {
    match current() {
        Lang::En => "RESET",
        Lang::ZhCn => "重置",
        Lang::ZhTw => "重設",
        Lang::Ja => "リセット",
        Lang::Ko => "초기화",
        // 不用 RÉINITIALISER：大写的 É 在法语键盘上很难打
        Lang::Fr => "EFFACER",
        Lang::Es => "RESTABLECER",
        Lang::De => "ZURÜCKSETZEN",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_serialize_as_code_and_args_for_the_ui() {
        let text = t("tree.refused").arg("count", 2usize).arg("names", vec!["a".to_string(), "b".to_string()]).arg("why", t("store.hosts")).detail("boom");
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            serde_json::json!({ "code": "tree.refused", "args": { "count": 2, "names": ["a", "b"], "why": { "code": "store.hosts" }, "detail": "boom" } })
        );
        assert_eq!(serde_json::to_value(t("x")).unwrap(), serde_json::json!({ "code": "x" }));
    }

    #[test]
    fn system_language_tags_map_like_the_interface_does() {
        for (tag, lang) in [
            ("zh-CN", Lang::ZhCn),
            ("zh", Lang::ZhCn),
            ("zh-Hans-CN", Lang::ZhCn),
            ("zh-SG", Lang::ZhCn),
            ("zh-TW", Lang::ZhTw),
            ("zh-HK", Lang::ZhTw),
            ("zh-MO", Lang::ZhTw),
            ("zh-Hant-TW", Lang::ZhTw),
            ("ja-JP", Lang::Ja),
            ("ko-KR", Lang::Ko),
            ("fr-CA", Lang::Fr),
            ("es-419", Lang::Es),
            ("de-AT", Lang::De),
            ("en-GB", Lang::En),
            ("pt-BR", Lang::En),
            ("", Lang::En),
        ] {
            assert_eq!(lang_from_tag(tag), lang, "{tag}");
        }
    }

    #[test]
    fn the_startup_error_names_the_folder_and_the_reason_in_every_language() {
        for lang in Lang::ALL {
            let text = startup_error(lang, r"D:\tools\data", "拒绝访问 / access denied");
            assert!(text.contains(r"D:\tools\data") && text.contains("access denied"), "{text}");
            assert!(text.contains("TermiPaw.exe"), "{text}");
        }
    }

    #[test]
    fn unknown_languages_fall_back_to_english() {
        assert_eq!(Lang::parse("zh-TW"), Some(Lang::ZhTw));
        assert_eq!(Lang::parse("pt-BR"), None);
        for lang in Lang::ALL {
            assert_eq!(Lang::parse(lang.code()), Some(lang));
        }
    }
}
