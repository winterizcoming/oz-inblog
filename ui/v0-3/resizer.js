function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function bindPanelResizer(nodes) {
  if (!nodes.resizer || !nodes.center || !nodes.right) return;

  const savedWidth = localStorage.getItem("oz-inblog-conversation-width");
  if (savedWidth) {
    document.documentElement.style.setProperty("--conversation-width", `${savedWidth}px`);
  }

  nodes.resizer.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 860) return;

    event.preventDefault();

    const startX = event.clientX;
    const centerStart = nodes.center.getBoundingClientRect().width;
    const rightStart = nodes.right.getBoundingClientRect().width;
    const total = centerStart + rightStart;
    const isV06 = document.body.classList.contains("v06-active");
    const minCenter = isV06 ? 360 : 420;
    const minRight = isV06 ? 360 : 420;

    nodes.resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-panels");

    function onPointerMove(moveEvent) {
      const delta = moveEvent.clientX - startX;
      const nextCenterWidth = clamp(centerStart + delta, minCenter, total - minRight);
      document.documentElement.style.setProperty("--conversation-width", `${Math.round(nextCenterWidth)}px`);
    }

    function onPointerUp(upEvent) {
      const finalWidth = Math.round(nodes.center.getBoundingClientRect().width);
      localStorage.setItem("oz-inblog-conversation-width", String(finalWidth));
      document.body.classList.remove("is-resizing-panels");

      nodes.resizer.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
}
