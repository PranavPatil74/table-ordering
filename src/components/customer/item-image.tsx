import { LogoMark } from "@/components/brand/logo-mark";

/**
 * Menu photos are not uploadable yet (storage arrives in a later phase), so every item shows this
 * branded tile. The component takes the item name so a real <img> can slot in with correct alt text.
 */
export function ItemImage({ name }: { name: string }) {
  return (
    <div
      role="img"
      aria-label={`No photo yet for ${name}`}
      className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-secondary sm:size-24"
    >
      <LogoMark className="size-9 opacity-80" />
    </div>
  );
}
