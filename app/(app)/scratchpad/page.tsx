import ScratchpadBoard from "@/components/scratchpad/scratchpad-board";

export const dynamic = "force-dynamic";

export default function ScratchpadPage() {
  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6">
        <h1 className="text-2xl font-semibold">Price Board</h1>
        <p className="text-sm text-muted-foreground">
          Rough, pre-finalized pricing ideas. Display only — never affects real product pricing.
        </p>
        <ScratchpadBoard />
      </div>
    </div>
  );
}
