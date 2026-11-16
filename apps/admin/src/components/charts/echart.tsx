'use client';

import { cn } from '@shotx/ui';
import { useEffect, useRef } from 'react';
import { type ChartInstance, type ChartOption, initChart } from '@/lib/charts/echarts';

/**
 * One Apache ECharts chart, drawn on the client only (the server renders the empty box). Each new
 * `option` replaces the previous one (notMerge), so series that disappear go with it and
 * surviving series keep the colours their option gives them. Resizes with its box (the cards are
 * full width on phones). `label` names the chart for screen readers; every chart also has a
 * table view (ChartCard).
 */
export function EChart({
  option,
  label,
  height = 288,
  className,
}: {
  option: ChartOption;
  label: string;
  height?: number;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartInstance | null>(null);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const instance = initChart(element);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      data-testid="echart"
      className={cn('w-full min-w-0', className)}
      style={{ height }}
    />
  );
}
