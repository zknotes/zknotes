import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines Tailwind CSS classes using clsx and tailwind-merge.
 * This ensures that conflicting Tailwind classes are resolved correctly
 * (e.g. `px-2 px-4` -> `px-4`).
 */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
