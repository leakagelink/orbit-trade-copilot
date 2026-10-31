// TradingView Lightweight Charts (open source, Apache-2.0). Loaded in the browser only.
import { useEffect, useRef } from "react";
import type { Candle } from "@/lib/indicators";

export interface PriceLineSpec { price: number; color: string; title: string }

const FALLBACK: Record<string, string> = { "--gain": "#4ade80", "--loss": "#f87171", "--primary": "#22c55e", "--border": "#2a2f3a", "--muted-foreground": "#9aa3b2" };
function cssVar(name: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !v) return FALLBACK[name] ?? "#9aa3b2";
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 1, 1);
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${(pixel[3] ?? 255) / 255})`;
}

export function TvChart({ candles, lines = [], height = 420 }: { candles: Candle[]; lines?: PriceLineSpec[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = useRef<{ chart: any; series: any; volume: any; lines: any[] } | null>(null);

  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | undefined;
    (async () => {
      try {
      const lw = await import("lightweight-charts");
      if (disposed || !el.current) return;
      const fg = cssVar("--muted-foreground"), grid = cssVar("--border"), gain = cssVar("--gain"), loss = cssVar("--loss");
      const chart = lw.createChart(el.current, {
        autoSize: true,
        layout: { background: { type: lw.ColorType.Solid, color: "transparent" }, textColor: fg, fontFamily: "JetBrains Mono, monospace" },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid, timeVisible: true },
        crosshair: { mode: lw.CrosshairMode.Normal },
      });
      const series = chart.addSeries(lw.CandlestickSeries, { upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss });
      const volume = chart.addSeries(lw.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", color: grid });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      api.current = { chart, series, volume, lines: [] };
      observer = new MutationObserver(() => {
        const fg = cssVar("--muted-foreground"), grid = cssVar("--border"), gain = cssVar("--gain"), loss = cssVar("--loss");
        chart.applyOptions({ layout: { textColor: fg }, grid: { vertLines: { color: grid }, horzLines: { color: grid } }, rightPriceScale: { borderColor: grid }, timeScale: { borderColor: grid } });
        series.applyOptions({ upColor: gain, downColor: loss, wickUpColor: gain, wickDownColor: loss });
        volume.applyOptions({ color: grid });
        api.current?.lines.forEach((line, index) => { const spec = lines[index]; if (spec) line.applyOptions({ color: cssVar(spec.color) }); });
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      el.current.dispatchEvent(new Event("tv-ready"));
      } catch (e) { console.error("TvChart init failed:", e); }
    })();
    return () => { disposed = true; observer?.disconnect(); api.current?.chart.remove(); api.current = null; };
  }, []);

  useEffect(() => {
    const apply = () => {
      const a = api.current;
      if (!a) return;
      const seen = new Set<number>();
      const rows = candles.filter((c) => { const t = Math.floor(c.t / 1000); if (seen.has(t)) return false; seen.add(t); return true; });
      a.series.setData(rows.map((c) => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c })));
      a.volume.setData(rows.map((c) => ({ time: Math.floor(c.t / 1000), value: c.v })));
      a.lines.forEach((l) => a.series.removePriceLine(l));
      a.lines = lines.map((l) => a.series.createPriceLine({ price: l.price, color: cssVar(l.color), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }));
    };
    apply();
    const node = el.current;
    node?.addEventListener("tv-ready", apply);
    return () => node?.removeEventListener("tv-ready", apply);
  }, [candles, lines]);

  return <div ref={el} style={{ height }} className="w-full" />;
}
