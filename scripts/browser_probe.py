"""Real-browser acceptance probe for the dsh-codex-project plugin.

Drives a live `dsh web` GUI with Playwright (system Chrome channel, so no
bundled-browser download) and asserts the plugin's whole mount surface against
a real host — the things jsdom tests can only fake:

  1. the plugin client enters the client module graph (__DSH_BOOT__ entry)
  2. the 项目文件夹 tab exists in the NATIVE right sidebar and opens
  3. the multi-root tree renders from the plugin's own /project route
  4. expanding a root hits the plugin's own /list route (multi-root fence)
  5. clicking a readable file hands off to the HOST viewer via openResource
  6. right-click 编辑 opens the plugin's OWN page with CodeMirror mounted,
     a clean 保存, dirty-state enabling, and a real POST to /write
  7. right-click 引用到对话 injects a real reference chip into the composer
  8. no page exceptions and no console errors throughout

DOM facts this script depends on, learned by inspecting the live GUI:
  * the native right bar starts COLLAPSED (rightbarCol width 0); it is opened
    with `button[aria-label="打开右侧边栏"]`
  * a per-workspace "new session" button only materializes on row hover
  * tree rows are `.dsh-cxp-tree-row`, dirs add `.dsh-cxp-tree-dir`
  * the plugin's own tab/panel scope carries `data-dsh-codex-project-tab`
  * the context menu is `[role="menu"]` with `[role="menuitem"]` buttons, and
    its items DIFFER by target (dir vs file) — see MENU_* below

Usage:
  python scripts/browser_probe.py <baseUrl> <outDir> [--headed]
"""

import asyncio
import json
import sys
from playwright.async_api import async_playwright

BASE = sys.argv[1]
OUT = sys.argv[2]
HEADED = "--headed" in sys.argv

# Menu items differ by target kind; both lists are asserted below.
MENU_DIR = ["引用到对话", "上传到此处", "用文件管理器打开", "复制相对路径", "复制绝对路径"]
MENU_FILE = ["引用到对话", "下载", "编辑", "复制相对路径", "复制绝对路径"]
FILE_EXT = (".md", ".json", ".yml", ".yaml", ".ts", ".tsx", ".mjs", ".txt", ".py")

REPORT = {"steps": [], "console": [], "pageErrors": [], "requests": []}
LOG = []


def step(name, ok, detail=""):
    REPORT["steps"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
    LOG.append(("OK  " if ok else "XX  ") + name + ((" -- " + str(detail)) if detail else ""))


def is_file(text):
    return text.lower().endswith(FILE_EXT)


async def open_plugin_tab(page):
    """Start a session in the plugin's workspace and open its sidebar tab."""
    row = page.locator('text=dsh-codex-project').first
    if await row.count() > 0:
        try:
            await row.hover(timeout=8000)
            await page.wait_for_timeout(600)
        except Exception:
            pass
    new_session = page.locator('button[aria-label="在“dsh-codex-project”中新建会话"]')
    if await new_session.count() > 0:
        try:
            await new_session.first.click(timeout=8000)
        except Exception:
            await row.click(timeout=8000)
    await page.wait_for_timeout(6000)

    # The native right bar is collapsed by default.
    right = page.locator('button[aria-label="打开右侧边栏"]')
    if await right.count() > 0:
        await right.first.click(timeout=8000)
        await page.wait_for_timeout(3000)

    tab = page.locator('[role="tab"]').filter(has_text="项目文件夹")
    if await tab.count() == 0:
        tab = page.locator('button').filter(has_text="项目文件夹")
    await tab.first.click(timeout=8000)
    await page.wait_for_timeout(3500)


async def expand_primary_root(page):
    await page.locator('.dsh-cxp-tree-row.dsh-cxp-tree-dir').first.click(timeout=8000)
    await page.wait_for_timeout(4500)


async def tree_rows(page):
    """Snapshot the tree rows as (text, kind) at call time.

    Re-read before every interaction: opening a file collapses/re-renders the
    tree, so an index captured earlier no longer addresses the same node.
    """
    return await page.evaluate("""() => {
      const el = document.querySelector('[data-dsh-codex-project-tab]');
      if (!el) return [];
      return [...el.querySelectorAll('.dsh-cxp-tree-row')].map(r => ({
        text: (r.innerText||'').trim(),
        dir: r.classList.contains('dsh-cxp-tree-dir'),
      }));
    }""")


async def right_click_row(page, predicate):
    """Right-click the first row matching `predicate(text, isDir)`; return text."""
    return await page.evaluate("""(src) => {
      const fn = eval('(' + src + ')');
      const el = document.querySelector('[data-dsh-codex-project-tab]');
      if (!el) return null;
      const rows = [...el.querySelectorAll('.dsh-cxp-tree-row')];
      const hit = rows.find(r => fn((r.innerText||'').trim(), r.classList.contains('dsh-cxp-tree-dir')));
      if (!hit) return null;
      const t = (hit.innerText||'').trim();
      hit.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true,
        clientX: hit.getBoundingClientRect().left + 40,
        clientY: hit.getBoundingClientRect().top + 8}));
      return t;
    }""", predicate)


async def click_row(page, predicate):
    """Left-click the first row matching `predicate(text, isDir)`; return text."""
    return await page.evaluate("""(src) => {
      const fn = eval('(' + src + ')');
      const el = document.querySelector('[data-dsh-codex-project-tab]');
      if (!el) return null;
      const rows = [...el.querySelectorAll('.dsh-cxp-tree-row')];
      const hit = rows.find(r => fn((r.innerText||'').trim(), r.classList.contains('dsh-cxp-tree-dir')));
      if (!hit) return null;
      const t = (hit.innerText||'').trim();
      hit.click();
      return t;
    }""", predicate)


async def menu_items(page):
    return await page.evaluate("""() => {
      const m = document.querySelector('[role="menu"]');
      if (!m) return [];
      return [...m.querySelectorAll('[role="menuitem"],button')]
        .map(b => (b.textContent||'').trim()).filter(Boolean);
    }""")


async def click_menu(page, label):
    return await page.evaluate("""(label) => {
      const m = document.querySelector('[role="menu"]');
      if (!m) return false;
      const b = [...m.querySelectorAll('[role="menuitem"],button')]
        .find(x => (x.textContent||'').trim() === label);
      if (!b) return false;
      b.click();
      return true;
    }""", label)


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            channel="chrome", headless=not HEADED, args=["--no-sandbox"])
        ctx = await browser.new_context(viewport={"width": 1680, "height": 1050})
        page = await ctx.new_page()
        page.on("console", lambda m: REPORT["console"].append({"type": m.type, "text": m.text}))
        page.on("pageerror", lambda e: REPORT["pageErrors"].append(str(e)))
        page.on("request", lambda r: REPORT["requests"].append(
            {"method": r.method, "url": r.url}) if "/codex-project/" in r.url else None)

        # ---- 1. shell + plugin in the module graph ----
        await page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(7000)
        step("shell loaded", bool(await page.title()), await page.title())
        boot = await page.evaluate("() => JSON.stringify(globalThis.__DSH_BOOT__ || {})")
        step("plugin registered in __DSH_BOOT__", "dsh-codex-project" in boot)
        step("plugin injects only ui-slots",
             '"inject":["@deepseek-ai/dsh-client-ui-slots"]' in boot.replace(" ", ""))

        # ---- 2/3. tab + tree ----
        await open_plugin_tab(page)
        await page.screenshot(path=OUT + "/01-tab-open.png")

        tabs = await page.evaluate("""() => [...document.querySelectorAll('[role="tab"]')]
            .map(e => (e.textContent||'').trim())""")
        REPORT["tabs"] = tabs
        step("项目文件夹 tab present", any("项目文件夹" in t for t in tabs), str(tabs)[:160])

        tree = await page.evaluate("""() => {
          const el = document.querySelector('[data-dsh-codex-project-tab]');
          const rows = el ? [...el.querySelectorAll('.dsh-cxp-tree-row')] : [];
          return {scope: !!el, rows: rows.map(r => (r.innerText||'').trim()),
                  dirs: el ? el.querySelectorAll('.dsh-cxp-tree-dir').length : 0};
        }""")
        REPORT["tree"] = tree
        step("plugin tab scope rendered", tree["scope"])
        step("multi-root tree shows >=1 root", len(tree["rows"]) >= 1, str(tree["rows"])[:160])
        projects = [r for r in REPORT["requests"] if "/api/project" in r["url"]]
        step("plugin /project route called", len(projects) > 0, "calls=" + str(len(projects)))

        # ---- 4. expand a root -> plugin /list ----
        lists_before = len([r for r in REPORT["requests"] if "/api/list" in r["url"]])
        await expand_primary_root(page)
        lists_after = len([r for r in REPORT["requests"] if "/api/list" in r["url"]])
        rows = await tree_rows(page)
        REPORT["expandedRows"] = [r["text"] for r in rows]
        step("root expanded with children", len(rows) > 2, "rows=" + str(len(rows)))
        step("plugin /list route hit", lists_after > lists_before, "calls=" + str(lists_after))
        await page.screenshot(path=OUT + "/02-tree-expanded.png")

        STEP_FILE = "(t, d) => !d && /\\.(md|json|ya?ml|tsx?|mjs|txt|py)$/i.test(t)"
        STEP_DIR = "(t, d) => d && /^[.a-z]/i.test(t) && t.length < 24"

        file_text = next((r["text"] for r in rows if is_file(r["text"]) and not r["dir"]), None)
        step("found a real file row", file_text is not None, file_text or "")

        # ---- 5. file click -> host viewer (openResource) ----
        if file_text is not None:
            before_tabs = await page.evaluate(
                """() => [...document.querySelectorAll('[role="tab"]')].length""")
            got = await click_row(page, STEP_FILE)
            await page.wait_for_timeout(5000)
            after = await page.evaluate("""() => ({
              tabs: [...document.querySelectorAll('[role="tab"]')].map(e => (e.textContent||'').trim()),
              hasResource: (document.body.innerHTML||'').includes('dsh-resource://'),
            })""")
            REPORT["afterFileClick"] = after
            step("file opened a new tab", len(after["tabs"]) > before_tabs,
                 "clicked=" + str(got) + " tabs=" + str(after["tabs"])[:160])
            step("host resource address used", after["hasResource"])
            await page.screenshot(path=OUT + "/03-file-in-host-viewer.png")

        # ---- 6. context menus (dir vs file differ) ----
        # Re-expand: opening a file re-rendered the pane.
        await open_plugin_tab(page)
        await expand_primary_root(page)

        dir_text = await right_click_row(page, STEP_DIR)
        await page.wait_for_timeout(2200)
        dmenu = await menu_items(page)
        REPORT["dirMenu"] = dmenu
        step("directory menu correct", dmenu == MENU_DIR, "target=" + str(dir_text) + " " + str(dmenu))
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(900)

        file_text2 = await right_click_row(page, STEP_FILE)
        await page.wait_for_timeout(2200)
        fmenu = await menu_items(page)
        REPORT["fileMenu"] = fmenu
        step("file menu correct", fmenu == MENU_FILE, "target=" + str(file_text2) + " " + str(fmenu))
        await page.screenshot(path=OUT + "/04-file-menu.png")

        if file_text2 is not None:
            # ---- 7. 编辑 -> own page, CodeMirror, save -> /write ----
            step("clicked 编辑", await click_menu(page, "编辑"))
            await page.wait_for_timeout(5500)
            ed = await page.evaluate("""() => {
              const cm = document.querySelector('.dsh-cxp-preview-cm');
              const save = [...document.querySelectorAll('button')]
                .find(b => (b.textContent||'').trim() === '保存');
              return {hasCm: !!cm, cmHidden: cm ? cm.hasAttribute('hidden') : null,
                      cmLines: cm ? cm.querySelectorAll('.cm-line').length : 0,
                      saveFound: !!save, saveDisabled: save ? save.disabled : null};
            }""")
            REPORT["editor"] = ed
            step("CodeMirror mounted visible", ed["hasCm"] and ed["cmHidden"] is False,
                 "lines=" + str(ed["cmLines"]))
            step("保存 exists and starts disabled (clean)",
                 ed["saveFound"] and ed["saveDisabled"] is True,
                 "found=" + str(ed["saveFound"]) + " disabled=" + str(ed["saveDisabled"]))
            await page.screenshot(path=OUT + "/05-edit-mode.png")

            posts_before = len([r for r in REPORT["requests"] if r["method"] == "POST"])
            if ed["hasCm"]:
                await page.locator('.dsh-cxp-preview-cm').click(timeout=8000)
                await page.keyboard.press("Control+End")
                await page.keyboard.type("\n<!-- browser probe -->")
                await page.wait_for_timeout(1800)
                dirty = await page.evaluate("""() => {
                  const s = [...document.querySelectorAll('button')]
                    .find(b => (b.textContent||'').trim() === '保存');
                  return s ? s.disabled : null;
                }""")
                step("保存 enables when dirty", dirty is False, "disabled=" + str(dirty))
                await page.screenshot(path=OUT + "/06-dirty.png")
                await page.evaluate("""() => {
                  const s = [...document.querySelectorAll('button')]
                    .find(b => (b.textContent||'').trim() === '保存');
                  if (s) s.click();
                }""")
                await page.wait_for_timeout(4500)
            posts = [r for r in REPORT["requests"] if r["method"] == "POST"]
            step("plugin /write called on save", len(posts) > posts_before,
                 "posts=" + str([r["url"] for r in posts])[:200])
            await page.screenshot(path=OUT + "/07-saved.png")

        # ---- 8. 引用到对话 -> composer chip ----
        await open_plugin_tab(page)
        await expand_primary_root(page)
        ref_target = await right_click_row(page, STEP_FILE)
        await page.wait_for_timeout(2200)
        step("clicked 引用到对话", await click_menu(page, "引用到对话"))
        await page.wait_for_timeout(3500)
        comp = await page.evaluate("""() => {
          const chips = [...document.querySelectorAll('[class*="chip"],[class*="reference"]')]
            .map(e => (e.textContent||'').trim()).filter(Boolean);
          return {chips};
        }""")
        REPORT["composer"] = comp
        step("reference chip in composer",
             any(str(ref_target) in c for c in comp["chips"]),
             "target=" + str(ref_target) + " chips=" + str(comp["chips"]))
        await page.screenshot(path=OUT + "/08-reference-chip.png")

        # ---- 9. health ----
        REPORT["consoleErrors"] = [c for c in REPORT["console"] if c["type"] == "error"]
        step("no page exceptions", len(REPORT["pageErrors"]) == 0, str(REPORT["pageErrors"][:3]))
        step("no console errors", len(REPORT["consoleErrors"]) == 0,
             str([c["text"][:150] for c in REPORT["consoleErrors"][:4]]))
        await browser.close()


asyncio.run(main())

with open(OUT + "/report.json", "w", encoding="utf-8") as f:
    json.dump(REPORT, f, ensure_ascii=False, indent=2)
with open(OUT + "/log.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(LOG))

print("\n".join(LOG))
failed = [s for s in REPORT["steps"] if not s["ok"]]
print("\n%d/%d passed" % (len(REPORT["steps"]) - len(failed), len(REPORT["steps"])))
sys.exit(1 if failed else 0)
