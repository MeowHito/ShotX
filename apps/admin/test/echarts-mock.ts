import type { ChartInstance, ChartOption } from '@/lib/charts/echarts';

/**
 * Stand-in for lib/charts/echarts in jsdom (no canvas; test/setup.ts mocks the module with this).
 * Every chart the EChart wrapper creates is recorded with the options it was given, so tests can
 * check series, colours and labels.
 */
export interface FakeChart {
  element: HTMLElement;
  options: ChartOption[];
  disposed: boolean;
}

export const fakeCharts: FakeChart[] = [];

export function initChart(element: HTMLElement): ChartInstance {
  const chart: FakeChart = { element, options: [], disposed: false };
  fakeCharts.push(chart);
  return {
    setOption: (option: ChartOption) => {
      chart.options.push(option);
    },
    resize: () => undefined,
    dispose: () => {
      chart.disposed = true;
    },
  };
}

/** The latest option of the live chart labelled `label` (its aria-label). */
export function optionOf(label: string): ChartOption {
  const chart = fakeCharts
    .filter((c) => !c.disposed && c.element.getAttribute('aria-label') === label)
    .at(-1);
  const option = chart?.options.at(-1);
  if (option === undefined) throw new Error(`No chart labelled ${label}`);
  return option;
}

export function resetFakeCharts() {
  fakeCharts.length = 0;
}
