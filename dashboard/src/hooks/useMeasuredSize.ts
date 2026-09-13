import { useEffect, useRef, useState } from "react";

/**
 * Tracks whether a container has a real, non-zero layout size.
 *
 * Recharts' <ResponsiveContainer> logs
 *   "The width(-1) and height(-1) of chart should be greater than 0"
 * whenever it mounts inside an element that is still collapsed — e.g. a tab
 * panel that is hidden, a card inside a grid that hasn't been laid out yet, or
 * a parent with `display: none`. Gating the chart on a measured size removes
 * the warning and avoids a wasted render pass.
 *
 * Usage:
 *   const { ref, ready } = useMeasuredSize();
 *   <div ref={ref} className="h-[300px] w-full">{ready && <Chart/>}</div>
 */
export function useMeasuredSize<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height }
      );
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size, ready: size.width > 0 && size.height > 0 };
}
