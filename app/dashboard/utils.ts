// Shared pure utilities — safe to import from both Server and Client components.

export function formatDashDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function domainMonogramColor(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) & 0xffffffff;
  const palette = ["#e8f5e9","#e3f2fd","#fce4ec","#fff8e1","#ede7f6","#e0f7fa","#fbe9e7","#f3e5f5"];
  const textPalette = ["#2e7d32","#1565c0","#c62828","#f57f17","#4527a0","#00695c","#bf360c","#6a1b9a"];
  const idx = Math.abs(hash) % palette.length;
  return `background:${palette[idx]};color:${textPalette[idx]}`;
}
