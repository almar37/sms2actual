// Native dialogs contain keyboard focus and return it to the trigger on close.
export function modal(node: HTMLDialogElement) {
  node.showModal();
  const dismiss = (event: MouseEvent) => {
    if (event.target !== node) return;
    const bounds = node.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      node.close();
  };
  node.addEventListener('click', dismiss);
  return {
    destroy() {
      node.removeEventListener('click', dismiss);
      node.close();
    },
  };
}
