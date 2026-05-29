import { Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  mask?: boolean;
  label?: string;
}

export function PinPad({ value, onChange, maxLength = 8, mask = false, label }: Props) {
  const press = (k: string) => {
    if (k === "del") return onChange(value.slice(0, -1));
    if (value.length >= maxLength) return;
    onChange(value + k);
  };
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "del"];

  return (
    <div className="w-full max-w-sm mx-auto">
      {label && <p className="text-center text-sm text-muted-foreground mb-2">{label}</p>}
      <div
        className={cn(
          "h-16 rounded-2xl border-2 border-border bg-card flex items-center justify-center mb-4 px-4",
          "text-3xl tracking-[0.4em] font-mono font-semibold text-foreground",
          value && "border-accent shadow-[var(--shadow-glow)]",
        )}
      >
        {value
          ? mask
            ? "•".repeat(value.length)
            : value
          : <span className="text-muted-foreground/40 text-base tracking-normal font-sans">—</span>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {keys.map((k) => {
          if (k === "clear") {
            return (
              <Button
                key={k}
                type="button"
                variant="ghost"
                className="h-16 text-sm text-muted-foreground hover:text-destructive"
                onClick={() => onChange("")}
              >
                Borrar
              </Button>
            );
          }
          if (k === "del") {
            return (
              <Button
                key={k}
                type="button"
                variant="ghost"
                className="h-16"
                onClick={() => press("del")}
              >
                <Delete className="h-6 w-6" />
              </Button>
            );
          }
          return (
            <Button
              key={k}
              type="button"
              variant="secondary"
              className="h-16 text-2xl font-semibold bg-secondary hover:bg-secondary/80 active:scale-95 transition-transform"
              onClick={() => press(k)}
            >
              {k}
            </Button>
          );
        })}
      </div>
    </div>
  );
}