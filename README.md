# 去除双思维链

TavernHelper / SillyTavern 小插件。它会在当前回复的 `</content>` 已经输出后，继续监听后续流式文本；如果发现新的 `<thinking>`，就尝试立刻停止当前生成，并写入本地日志。

## 功能

- 常驻浮窗：插件启用后显示 🧠 浮窗，关闭守护也不会隐藏浮窗。
- 守护开关：浮窗面板内可开启 / 关闭自动停止。
- 保守检测：只在 `</content>` 之后检测异常复盘型 `<thinking>`，不会拦截最开头的正常思维链和普通续写思维。
- 谨慎处理：可选开启自动截断和截断后自动续写，并可自定义两个等待秒数。
- 收笔清理：生成结束且出现“此处收笔”后，可清理续写产生的完整闭合 `<thinking>...</thinking>`，并去掉两侧多余空白。
- 小剧场保险箱：可选保存异常前已闭合的 `<Episode>` 小剧场，并在“此处收笔”前补回。
- 流程日志：记录触发时间、第几楼、触发前 10 个字，并持续更新停止、删除、续写、收笔清理状态。
- 弹窗提示：异常停止、删除成功、点击续写、收笔清理完成或失败时会弹出提示。
- 删除备份：自动截断前先保存被删除内容，可按自然日导出 TXT。
- 本地保存：开关与日志保存在浏览器 `localStorage`。

自动截断、自动续写、小剧场保险箱默认关闭；需要测试时请在 🧠 浮窗面板里手动开启。

## 判定规则

1. 当前最新的非用户消息开始生成时，插件先建立基线。
2. 看到 `</content>` 前只做轻量闭合检测；看到 `</content>` 后，进入警戒状态。
3. 警戒状态下发现新的 `<thinking` 后，先观察短窗口；固定短句“我完全遵循PLUTO系统的要求”优先命中。
4. 如果开启自动截断，等待设定秒数后，只删除第二个 `<thinking` 起到当前消息末尾的内容。
5. 如果开启自动续写，删除后再等待设定秒数，然后触发继续。
6. 如果开启小剧场保险箱，会保存异常点前已完整闭合且包含 `<small_theater>` 的 `<Episode>` 块。
7. 出现“此处收笔”后，插件先做续写 thinking 清理，再把保险箱里的小剧场插入到收笔标记前。
8. 如果固定短句有变体，则用 `PLUTO` + 多个强关键词兜底；当前页面只用任务锁防止重复安排，不保存已处理记录。

## 发布方式

1. 创建公开 GitHub 仓库，例如 `juxingmaomi/remove-double-thinking-chain`。
2. 上传 `index.js` 到仓库根目录。
3. 创建 tag / release：`v0.0.14`。
4. 在 TavernHelper 中粘贴 `tavern-helper-loader.template.js` 的内容。
5. 以后发布新版本后，只需要把 loader 里的 `VERSION` 改成新 tag，例如 `v0.0.2`。

## TavernHelper 加载器

推荐在 TavernHelper 中保留这段小加载器。以后更新版本时，只改 `VERSION`：

```js
(async () => {
  const REPO = 'juxingmaomi/remove-double-thinking-chain';
  const VERSION = 'v0.0.14';
  const URL = `https://gcore.jsdelivr.net/gh/${REPO}@${VERSION}/index.js`;

  const loaderState = {
    repo: REPO,
    loadedTag: VERSION,
    source: 'manual',
    url: URL,
    requestedAt: new Date().toISOString(),
  };
  window.__TH_REMOVE_DOUBLE_THINKING_CHAIN_LOADER__ = loaderState;

  function popup(type, message) {
    try {
      let toastr = window.toastr;
      try {
        if (!toastr && window.parent && window.parent !== window) {
          toastr = window.parent.toastr;
        }
      } catch (_) {}
      if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message);
        return;
      }
      if (type === 'error') {
        alert(message);
        return;
      }
      console.log(`[remove-double-thinking-chain] ${message}`);
    } catch (error) {
      console.warn('[remove-double-thinking-chain] Popup failed.', error);
    }
  }

  try {
    await import(URL);
    loaderState.loadedAt = new Date().toISOString();
    popup('success', `去除双思维链已加载 ${VERSION}`);
  } catch (error) {
    loaderState.error = String(error && error.message || error);
    console.error('[remove-double-thinking-chain] Load failed.', error);
    popup('error', `去除双思维链 ${VERSION} 加载失败。请确认 GitHub 已发布这个版本。`);
  }
})();
```

当前固定版本入口：

```js
https://gcore.jsdelivr.net/gh/juxingmaomi/remove-double-thinking-chain@v0.0.14/index.js
```

如果仓库名不同，修改 loader 里的 `REPO` 即可。

## 注意

- 只有开启“截断后自动续写”时，插件才会在删除后尝试点击继续。
- 它只能在第二个 `<thinking>` 已经开始出现后停止，所以可能仍会多生成几个字符。
- 如果当前酒馆版本没有暴露停止函数，插件会尝试点击可见的停止生成按钮。
- 插件不会点击 `#send_but` 发送键，避免在空闲状态误开新生成。
