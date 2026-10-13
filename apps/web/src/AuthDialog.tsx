import { useEffect, useRef, type ReactNode } from "react";

export function AuthDialog({ children, busy, onClose }: { children: ReactNode; busy: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className="auth-dialog card" aria-labelledby="auth-title" aria-describedby="auth-description"
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={event => {
        if (busy || event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
      }}>
      <button className="auth-close" type="button" aria-label="Close sign-in window" disabled={busy} onClick={onClose}>×</button>
      {children}
    </dialog>
  );
}
