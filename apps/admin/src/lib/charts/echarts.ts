import { BarChart, type BarSeriesOption } from 'echarts/charts';
import {
  GridComponent,
  type GridComponentOption,
  LegendComponent,
  type LegendComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
} from 'echarts/components';
import { type ComposeOption, type EChartsType, init, use as registerEcharts } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * Apache ECharts, the admin's chart library (skill: Tech stack), registered with only what the
 * admin's charts use: bar series, the grid, tooltips and legends, drawn on a canvas. Every chart
 * goes through components/charts/echart.tsx; tests replace this module (test/setup.ts), since
 * jsdom has no canvas.
 */
registerEcharts([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type ChartOption = ComposeOption<
  BarSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption
>;

export type ChartInstance = Pick<EChartsType, 'setOption' | 'resize' | 'dispose'>;

/** A chart on `element` (canvas renderer). */
export function initChart(element: HTMLElement): ChartInstance {
  return init(element, null, { renderer: 'canvas' });
}
