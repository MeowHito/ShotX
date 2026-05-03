'use client';

export type BarDatum = { label: string; value: number };

export function BarChart({ data, height = 180, formatValue }: { data: BarDatum[]; height?: number; formatValue?: (v: number) => string }) {
  if (!data.length) {
    return <div className="rounded-xl border border-violet-500/10 bg-white/[0.02] p-6 text-sm text-violet-100/50">ยังไม่มีข้อมูล</div>;
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  const fmt = formatValue ?? ((v: number) => v.toLocaleString());
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d) => {
          const h = Math.max(2, Math.round((d.value / max) * (height - 28)));
          return (
            <div key={d.label} className="flex flex-1 flex-col items-center gap-1">
              <div className="text-[10px] text-violet-100/50">{fmt(d.value)}</div>
              <div className="w-full rounded-t bg-gradient-to-t from-violet-500/40 to-fuchsia-400/80" style={{ height: h }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        {data.map((d) => (
          <div key={d.label} className="flex-1 truncate text-center text-[10px] text-violet-100/50">{d.label}</div>
        ))}
      </div>
    </div>
  );
}
