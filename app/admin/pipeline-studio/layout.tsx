import { notFound } from "next/navigation";
import StudioNav from "./components/StudioNav";
import { BG, FONT_STACK } from "@/app/sites/[id]/design-tokens";

export default function PipelineStudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Pipeline studio writes to local files via its workflow editor — keep
  // dev-only even though the parent admin layout already requires admin auth.
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: FONT_STACK,
        background: BG,
      }}
    >
      <StudioNav />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          padding: "32px 40px",
          overflowY: "auto",
        }}
      >
        {children}
      </main>
    </div>
  );
}
