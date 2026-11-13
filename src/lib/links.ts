// 项目的网址。在线更新的地址也在这个仓库下（见 tauri.conf.json），仓库不能改名
import { currentLang } from "../i18n";

export const REPO_URL = "https://github.com/carsonxzhang/TermiPaw";
export const ISSUES_URL = `${REPO_URL}/issues`;

/** 使用说明：中文界面打开中文的 README，其余语言打开英文的 */
export const helpUrl = () => (currentLang().startsWith("zh") ? `${REPO_URL}/blob/main/README.zh-CN.md` : `${REPO_URL}#readme`);
