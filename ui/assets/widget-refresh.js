// Reload only this real-time view. The public SDK cannot restart the App backend.
export function bindWidgetReload(button, {
  reload = () => window.location.reload(),
  paint = run => requestAnimationFrame(() => requestAnimationFrame(run)),
  later = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let busy = false, failed = false, disposed = false, started = false;
  let fallback = null, deadline = null;
  const explanation = '点击重新加载实时用量页面并拉取数据；不会重启插件后端';
  const clearTimers = () => { if (fallback != null) cancel(fallback); if (deadline != null) cancel(deadline); fallback = deadline = null; };
  function fail(error) {
    if (disposed || !busy) return;
    clearTimers(); busy = false; failed = true;
    button.disabled = false; button.classList.remove('refreshing'); button.classList.add('reload-failed');
    button.setAttribute('aria-busy', 'false'); button.textContent = '刷新失败';
    button.title = `页面刷新未完成，点击重试${error?.message ? '：' + error.message : ''}。${explanation}`;
    button.setAttribute('aria-label', '刷新失败，点击重试');
  }
  function click() {
    if (busy || disposed) return;
    busy = true; failed = false; started = false;
    button.disabled = true; button.classList.remove('stale', 'reload-failed'); button.classList.add('refreshing');
    button.textContent = '刷新中'; button.title = '正在重新加载实时用量页面';
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-busy', 'true');
    const run = () => {
      if (started || disposed || !busy) return;
      started = true;
      if (fallback != null) { cancel(fallback); fallback = null; }
      // A surviving document means navigation did not complete. Never claim success.
      deadline = later(() => fail(), 8000);
      try { reload(); } catch (error) { fail(error); }
    };
    fallback = later(run, 160);
    try { paint(run); } catch { run(); }
  }
  button.title = explanation; button.setAttribute('aria-label', '重新加载实时用量页面');
  button.addEventListener('click', click);
  return {
    get ownsStatus() { return busy || failed; },
    dispose() { disposed = true; clearTimers(); button.removeEventListener('click', click); },
  };
}
