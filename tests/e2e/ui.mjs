// 布局、左侧主机列表和多会话切换。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./harness.mjs";

export async function uiSuite(app, server, { check }) {
  const { click, hover, key, js, type, waitFor, authenticate, palette } = bind(app);

  const rows = () =>
    js(`JSON.stringify([...document.querySelectorAll(".host-list .host-item, .host-list .session-item, .host-list .group-head")].map(e => ({
      k: e.className.split(" ")[0], active: e.classList.contains("active"), selected: e.classList.contains("selected"),
      t: (e.querySelector(".name") || e).textContent.trim(), dot: e.querySelector(".dot")?.className.replace("dot","").trim() ?? "" })))`).then(JSON.parse);
  const visibleTerms = () => js(`[...document.querySelectorAll(".term-wrap")].filter(e => e.style.display !== "none").length`);
  const termCount = () => js(`document.querySelectorAll(".term-wrap").length`);
  const termFocused = () => js(`!!document.activeElement?.closest(".xterm")`);
  const menu = ".ctx-menu button";

  // ---- 布局 ----
  const layout = JSON.parse(
    await js(`JSON.stringify((() => { const r = s => document.querySelector(s).getBoundingClientRect();
      const img = r(".brand img"), name = r(".brand span");
      const search = document.querySelector(".sidebar > :first-child .search-trigger"), list = r(".host-list");
      return { imgW: img.width, gap: name.left - img.right, tabs: document.querySelectorAll(".tabs, .tab").length,
        searchInSidebarTop: !!search && search.getBoundingClientRect().bottom <= list.top && search.getBoundingClientRect().width > 150 && search.textContent.includes("Ctrl K"),
        searchInTitleBar: !!document.querySelector(".titlebar .search-trigger"),
        newHost: !!document.querySelector('.sidebar-foot .new-host') }; })())`),
  );
  check("标题栏图标 19px", layout.imgW === 19, `${layout.imgW}`);
  check("名称与图标间距 5px", layout.gap === 5, `${layout.gap}`);
  check("搜索框在左侧主机列表顶端", layout.searchInSidebarTop);
  check("标题栏里没有搜索框", !layout.searchInTitleBar);
  check("顶部没有标签", layout.tabs === 0);

  // 设置和主题在标题栏右上角（主题在左、设置在右，紧挨窗口按钮）；新建主机在侧栏底部最左边，带文字
  const bars = JSON.parse(
    await js(`JSON.stringify((() => { const r = e => e.getBoundingClientRect();
      const [theme, settings] = document.querySelectorAll(".titlebar-tools .icon-btn");  // 第二个是菜单按钮
      const win = r(document.querySelector(".winctl")), nh = document.querySelector(".sidebar-foot .new-host");
      const foot = [...document.querySelectorAll(".sidebar-foot > *")];
      return { count: document.querySelectorAll(".titlebar-tools .icon-btn").length, themeLeftOfSettings: r(theme).right <= r(settings).left,
        settingsBeforeWindow: r(settings).right <= win.left, inFoot: document.querySelectorAll(".sidebar-foot .icon-btn").length,
        newHostFirst: foot[0] === nh, newHostText: nh.textContent.trim().length > 0 }; })())`),
  );
  check("标题栏右侧有主题和菜单两个按钮", bars.count === 2, `${bars.count}`);
  check("主题在菜单按钮左边", bars.themeLeftOfSettings);
  check("菜单按钮在窗口按钮左边", bars.settingsBeforeWindow);
  check("侧栏底部没有图标按钮了", bars.inFoot === 0, `${bars.inFoot}`);
  check("新建主机在侧栏底部最左边", bars.newHostFirst);
  check("新建主机按钮带文字", bars.newHostText);

  // 菜单：设置、帮助、关于。保险库在设置里
  const menuItems = () => js(`JSON.stringify([...document.querySelectorAll(".ctx-menu button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })))`);
  // 测试版不打开浏览器，要打开的地址记在这里
  const openedLinks = () => (existsSync(join(app.dataDir, "opened-links.txt")) ? readFileSync(join(app.dataDir, "opened-links.txt"), "utf8").trim().split(/\r?\n/) : []);
  await click(".menu-btn");
  const items = JSON.parse(await menuItems());
  check("菜单有三项：设置、帮助、关于", items.map((i) => i.text).join("|") === "设置|帮助|关于", JSON.stringify(items));
  check("菜单项都能点", items.every((i) => !i.disabled));
  await click(".menu-btn");
  check("再点一次菜单按钮：菜单关闭", (await menuItems()) === "[]");
  await click(".menu-btn");
  await click(".host-list");
  check("点别处：菜单关闭", (await menuItems()) === "[]");
  await click(".menu-btn");
  await click(".ctx-menu button", "帮助");
  await sleep(300);
  check("点帮助：中文界面打开中文说明", openedLinks().at(-1) === "https://github.com/carsonxzhang/TermiPaw/blob/main/README.zh-CN.md", openedLinks().join(" | "));
  check("点帮助：菜单收起", (await menuItems()) === "[]");
  await click(".menu-btn");
  await click(".ctx-menu button", "设置");
  check("点设置：打开设置窗口，菜单收起", (await js(`!!document.querySelector(".modal .settings-language")`)) && (await menuItems()) === "[]");
  // 没有更新地址时（这里的测试程序就是）没有启动检查开关，有地址时的开关在更新测试里点过
  check("设置窗口里没有版本和检查按钮", !(await js(`!!document.querySelector(".modal .update-section, .modal .update-check")`)));
  check("设置窗口里没有打开远程文件的程序和那两段说明", await js(`(() => { const m = document.querySelector(".modal"); return !m.querySelector(".editor-path") && !/AI|右键：|打开远程文件的程序/.test(m.textContent); })()`), await js(`document.querySelector(".modal").textContent`));
  check("保险库在设置里，有自己的标题", await js(`document.querySelector(".modal .settings-section h4")?.textContent === "主密码保险库" && !!document.querySelector(".modal .settings-section .vault-enable")`));

  // 每个设置项都有问号，说明不直接写在旁边
  const helpTexts = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll(".modal .help-tip")].map((t) => t.getAttribute("aria-label")))`));
  // 语言、主题、字体、字号、光标、三个开关、保险库。测试程序没有更新地址，没有启动检查开关
  check("设置：从语言开始每一项都有问号", helpTexts.length === 9 && helpTexts.every((t) => t && t.length > 10), JSON.stringify(helpTexts));
  check("设置：旁边不再有灰色的说明文字", !(await js(`!!document.querySelector(".modal .hint")`)), await js(`[...document.querySelectorAll(".modal .hint")].map((e) => e.textContent).join(" | ")`));
  check("设置：没开保险库时只有开启按钮", (await js(`document.querySelector(".modal .vault-section")?.textContent.trim()`)) === "开启保险库…", await js(`document.querySelector(".modal .vault-section")?.textContent`));
  const pop = () => js(`document.querySelector(".help-pop")?.textContent ?? ""`);
  check("说明：平时不显示", (await pop()) === "");
  await hover(".modal .help-tip");
  check("说明：鼠标移到问号上时显示", (await pop()).startsWith("界面显示语言"), await pop());
  const popInside = await js(`(() => { const r = document.querySelector(".help-pop").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`);
  check("说明：完整显示在窗口内", popInside);
  await hover(".modal-head h3");
  check("说明：鼠标移开后消失", (await pop()) === "");
  const copyBefore = await js(`document.querySelectorAll(".modal .switch input")[0].checked`);
  await click(".modal .switch .help-tip");
  check("说明：点开关旁边的问号不会切换开关", (await js(`document.querySelectorAll(".modal .switch input")[0].checked`)) === copyBefore);
  await click(".modal-head .icon-btn");
  await click(".menu-btn");
  await click(".ctx-menu button", "关于");
  check("点关于：有名称、版本和检查按钮，没有启动时检查开关", await js(`(() => { const m = document.querySelector(".modal"); return m.querySelector(".about-head")?.textContent.includes("TermiPaw") && !!m.querySelector(".update-section") && !!m.querySelector(".update-check") && !m.querySelector(".update-startup"); })()`));
  check("关于窗口：标题只有图标和 TermiPaw，正文没有“更新”标题", await js(`(() => { const m = document.querySelector(".modal"); return m.querySelector("h3").textContent.trim() === "TermiPaw" && !!m.querySelector("h3 img") && !m.querySelector(".modal-body label"); })()`), await js(`document.querySelector(".modal").textContent`));
  check("关于窗口：有简介和许可证", (await js(`document.querySelector(".modal .about-tagline")?.textContent ?? ""`)).includes("SSH") && (await js(`document.querySelector(".modal .about-license")?.textContent ?? ""`)).includes("Apache-2.0"));
  await click(".modal .about-source");
  await sleep(300);
  check("关于窗口：源代码链接打开仓库", openedLinks().at(-1) === "https://github.com/carsonxzhang/TermiPaw", openedLinks().join(" | "));
  await click(".modal .about-issues");
  await sleep(300);
  check("关于窗口：反馈问题打开 Issues", openedLinks().at(-1) === "https://github.com/carsonxzhang/TermiPaw/issues", openedLinks().join(" | "));
  await click(".modal-head .icon-btn");
  check("关闭关于窗口", !(await js(`!!document.querySelector(".modal")`)));
  // 点搜索框仍然打开命令面板
  await click(".sidebar-search .search-trigger");
  check("点侧栏搜索框：打开命令面板", await js(`!!document.querySelector(".palette")`));
  await key("Escape", "Escape", 27);
  check("新建主机入口仍在", layout.newHost);

  // ---- 新建主机窗口：不预填、没有占位文字，说明都在问号里 ----
  await click(".sidebar-foot .new-host");
  await waitFor(`!!document.querySelector(".modal .host-name")`);
  const editor = await js(`(() => {
    const m = document.querySelector(".modal");
    return {
      username: m.querySelector(".host-username").value,
      port: m.querySelector(".host-port").value,
      placeholders: [...m.querySelectorAll("input")].map((i) => i.placeholder).filter(Boolean),
      hints: m.querySelectorAll(".hint").length,
      tips: m.querySelectorAll(".help-tip").length,
    };
  })()`);
  check("新建主机：用户名和端口都留空", editor.username === "" && editor.port === "", JSON.stringify(editor));
  check("新建主机：输入框里没有占位文字", editor.placeholders.length === 0, editor.placeholders.join(" | "));
  check("新建主机：没有直接显示的提示文字", editor.hints === 0, String(editor.hints));
  // 名称、分组、地址、端口、用户名、编码、认证方式、密码、保存密码
  check("新建主机：每一项都有问号", editor.tips === 9, String(editor.tips));
  await click(".modal .segmented button", "私钥");
  check("选私钥：私钥文件和口令也有问号", (await js(`document.querySelectorAll(".modal .help-tip").length`)) === 10);
  await click(".modal .segmented button", "SSH Agent");
  check("选 Agent：没有密码相关的项，也没有直接显示的说明", (await js(`document.querySelectorAll(".modal .help-tip").length`)) === 7 && (await js(`document.querySelectorAll(".modal .hint").length`)) === 0);
  await hover(".modal .field:has(.segmented) .help-tip");
  check("认证方式的说明分三行列出", await waitFor(`document.querySelector(".help-pop")?.innerText.split("\\n").length === 3`), await js(`document.querySelector(".help-pop")?.innerText ?? ""`));
  await click(".modal .segmented button", "密码");

  const toastHas = (text) => waitFor(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, 3000);
  await click(".modal .host-address");
  await type("127.0.0.1");
  await click(".modal .btn", "保存");
  check("没填用户名：不保存，提示填写", (await toastHas("请填写用户名")) && (await js(`!!document.querySelector(".modal")`)));
  await click(".modal .host-username");
  await type("root");
  await click(".modal .host-port");
  await type("70000");
  await click(".modal .btn", "保存");
  check("端口超出范围：不保存，提示范围", (await toastHas("1 到 65535")) && (await js(`!!document.querySelector(".modal")`)));
  await js(`(() => { const el = document.querySelector(".modal .host-port"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await click(".modal .host-name");
  await type("port-default");
  await click(".modal .btn", "保存");
  await sleep(300);
  const portDefault = JSON.parse(readFileSync(join(app.dataDir, "hosts.json"), "utf8")).find((h) => h.name === "port-default");
  check("端口留空：按 22 保存", portDefault?.port === 22 && portDefault?.username === "root", JSON.stringify(portDefault));
  await click(".host-item", "port-default", { button: "right" });
  await click(".ctx-menu button", "删除");
  await click(".modal .btn", "删除");
  await sleep(300);

  // ---- 建两台主机 ----
  const addHost = async (name, group) => {
    await click('.sidebar-foot .new-host');
    const fields = { ".host-name": name, ".host-group": group, ".host-address": "127.0.0.1", ".host-port": String(server.port), ".host-username": "root" };
    for (const [selector, v] of Object.entries(fields)) {
      await click(`.modal ${selector}`);
      await type(v);
    }
    await click(".modal .btn", "保存");
    await sleep(300);
  };
  await addHost("web-01", "生产");
  await addHost("db-01", "生产");
  let r = await rows();
  check("两台主机在列表中", r.filter((x) => x.k === "host-item").length === 2, r.map((x) => x.t).join(","));

  // ---- 单击未连接：只选中，不连接 ----
  await click(".host-item", "web-01");
  check("单击未连接主机：不连接", (await termCount()) === 0);
  r = await rows();
  check("单击未连接主机：选中高亮", r.find((x) => x.t === "web-01").selected);

  // ---- 双击连接 ----
  await click(".host-item", "web-01", { count: 2 });
  await sleep(200);
  await authenticate();
  check("双击连接：建立一个会话", (await termCount()) === 1);
  check("连接后显示状态", await waitFor(`document.querySelector(".host-item .dot")?.classList.contains("connected")`));
  r = await rows();
  check("已连接行高亮", r.find((x) => x.t === "web-01").active);
  check("焦点在终端", await waitFor(`!!document.activeElement?.closest(".xterm")`));

  // ---- 单击已连接：切换，不新开 ----
  await click(".host-item", "web-01");
  check("单击已连接主机：不重复连接", (await termCount()) === 1);
  check("点击列表后终端仍有焦点", await termFocused());
  await click(".host-item", "web-01", { count: 2 });
  check("双击已连接主机：不重复连接", (await termCount()) === 1);

  // ---- 连第二台，切换 ----
  await hover(".host-item", "db-01");
  await click('.host-item .row-actions [title="连接"]');
  await authenticate();
  check("悬停按钮连接第二台", (await termCount()) === 2);
  r = await rows();
  check("当前会话切到 db-01", r.find((x) => x.t === "db-01").active && !r.find((x) => x.t === "web-01").active);
  await click(".host-item", "web-01");
  r = await rows();
  check("单击切回 web-01", r.find((x) => x.t === "web-01").active && (await visibleTerms()) === 1);
  check("切换后焦点在终端", await waitFor(`!!document.activeElement?.closest(".xterm")`));

  // ---- 同一主机多会话：子行 ----
  await click(".host-item", "web-01", { button: "right" });
  await click(menu, "新建会话");
  await authenticate();
  check("右键新建会话", (await termCount()) === 3);
  r = await rows();
  const subs = r.filter((x) => x.k === "session-item");
  check("展开两个子行", subs.length === 2, subs.map((s) => s.t + (s.active ? "*" : "")).join(","));
  check("子行 2 为当前", subs[1]?.active);
  check("主机行显示数量", (await js(`document.querySelector(".session-count")?.textContent`)) === "2");
  await click(".session-item", "会话 1");
  r = await rows();
  check("点击子行切换", r.filter((x) => x.k === "session-item")[0].active);
  await key("Tab", "Tab", 9, 2);
  const activeRows = async () => (await rows()).filter((x) => x.active).map((x) => x.t).join();
  const tab1 = await activeRows();
  check("Ctrl+Tab 按列表顺序到下一个", tab1 === "会话 2", tab1);
  await key("Tab", "Tab", 9, 2);
  const tab2 = await activeRows();
  check("Ctrl+Tab 到末尾后绕回开头", tab2 === "db-01", tab2);
  await key("Tab", "Tab", 9, 2 | 8);
  const tab3 = await activeRows();
  check("Ctrl+Shift+Tab 反向", tab3 === "会话 2", tab3);
  await click(".session-item", "会话 1");

  // 关闭会话 1 后，会话 2 不改名，子行收起
  await hover(".session-item", "会话 1");
  await click('.session-item .row-actions [title^="关闭会话"]');
  r = await rows();
  check("关闭一个后收起子行", r.filter((x) => x.k === "session-item").length === 0 && (await termCount()) === 2);
  await click(".host-item", "web-01", { button: "right" });
  await click(menu, "新建会话");
  await authenticate();
  const labels = (await rows()).filter((x) => x.k === "session-item").map((x) => x.t).join();
  check("编号保持稳定", labels === "会话 2,会话 3", labels);
  await click(".session-item", "会话 2");

  // ---- 快速连接：临时分组 ----
  await palette(`demo@127.0.0.1:${server.port}`);
  await authenticate();
  r = await rows();
  check("临时连接分组出现在最上方", r[0].t.includes("临时连接"), r[0].t);
  check("临时连接行为当前", r[1].active, r[1].t);

  // 命令面板选已连接主机：切换
  const before = await termCount();
  await palette("db-01");
  await sleep(200);
  r = await rows();
  check("命令面板选已连接主机：切换不新开", (await termCount()) === before && r.find((x) => x.t === "db-01").active);

  // 保存为主机：不重连，归到新主机
  await click(".host-item", "demo@127.0.0.1");
  const sessionBefore = await termCount();
  await click(".host-item", "demo@127.0.0.1", { button: "right" });
  await click(menu, "保存为主机");
  const nameInput = `.modal .host-name`;
  await click(nameInput);
  await js(`document.querySelector('${nameInput}').select()`);
  await type("saved-temp");
  await click(".modal .btn", "保存");
  await sleep(400);
  r = await rows();
  check("保存后临时分组消失", !r.some((x) => x.t.includes("临时连接")));
  const saved = r.find((x) => x.t === "saved-temp");
  check("保存后归到新主机且保持连接", saved?.dot === "connected" && saved?.active && (await termCount()) === sessionBefore, JSON.stringify(saved));

  // ---- 折叠分组时显示状态 ----
  await click(".group-head", "生产");
  check("折叠后分组仍显示状态", await js(`[...document.querySelectorAll(".group-head")].find(e => e.textContent.includes("生产")).querySelector(".dot")?.classList.contains("connected")`));
  await click(".group-head", "生产");

  // ---- Ctrl+W 全部关闭后回到欢迎页 ----
  for (let i = 0; i < 8 && (await termCount()) > 0; i++) await key("w", "KeyW", 87, 2);
  check("Ctrl+W 关闭全部后回到欢迎页", (await termCount()) === 0 && (await js(`!!document.querySelector(".welcome")`)));
  r = await rows();
  check("关闭后不再有状态点和子行", r.filter((x) => x.k === "host-item").every((x) => !x.dot) && !r.some((x) => x.k === "session-item"));
}

function bind(app) {
  const out = {};
  for (const name of ["click", "hover", "key", "js", "type", "waitFor", "authenticate", "palette"]) out[name] = app[name].bind(app);
  return out;
}
