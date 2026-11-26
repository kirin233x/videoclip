import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

// ------------------------------------------------------------------ Toast

interface ToastItem {
  id: number;
  text: ReactNode;
  error?: boolean;
  action?: { label: string; onClick: () => void };
}

type ToastFn = (text: ReactNode, opts?: { error?: boolean; action?: ToastItem["action"] }) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback<ToastFn>((text, opts = {}) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, text, ...opts }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), opts.error ? 5000 : opts.action ? 5000 : 2400);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
            {t.text}
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action!.onClick();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ 下拉菜单

export type MenuItem = { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onClick: () => void } | "sep";

export function Menu(props: { anchor: HTMLElement; onClose: () => void; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const rect = props.anchor.getBoundingClientRect();
  const { onClose } = props;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const left = Math.min(rect.right - 190, window.innerWidth - 206);
  return (
    <div ref={ref} className="menu" style={{ position: "fixed", top: rect.bottom + 6, left: Math.max(8, left) }}>
      {props.items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 杂项

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spin" style={{ width: size, height: size }} />;
}
