// The palettes for the folder context menu (a colour + an emoji icon) — lifted out of FolderItem.svelte.
// A deliberately smaller palette than constants/colors.ts (the editor's highlight palette) — these are
// folder accent colours, not text or highlight colours.
export const FOLDER_PRESET_COLORS = [
    "#ef4444", // red
    "#f97316", // orange
    "#eab308", // yellow
    "#22c55e", // green
    "#14b8a6", // teal
    "#3b82f6", // blue
    "#6366f1", // indigo
    "#a855f7", // purple
    "#ec4899", // pink
    "#a1a1aa", // gray
] as const;

export const FOLDER_PRESET_ICONS = [
    "📝",
    "📌",
    "💡",
    "📚",
    "🎯",
    "💻",
    "🔬",
    "🎨",
    "📊",
    "🔐",
    "🌟",
    "📅",
    "🔧",
    "🏷️",
    "✅",
    "🧪",
    "💼",
    "⚡",
    "🔑",
    "🎵",
    "🔒",
    "🔓",
    "👁️",
    "🧠",
    "📡",
    "🏗️",
    "🏦",
    "🌍",
    "🛸",
    "👻",
    "🕹️",
    "🧮",
    "🕸️",
    "🌋",
    "🌲",
    "🐾",
    "🌪️",
    "🌊",
    "🏔️",
    "🚀",
] as const;
