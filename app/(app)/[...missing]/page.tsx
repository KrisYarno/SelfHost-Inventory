import { notFound } from "next/navigation";

/**
 * Every authenticated URL no route matches (facelift F1-4). Static segments
 * still win; this only catches what nothing else does, so the not-found page
 * renders inside the shell instead of on a bare screen.
 */
export default function MissingPage() {
  notFound();
}
